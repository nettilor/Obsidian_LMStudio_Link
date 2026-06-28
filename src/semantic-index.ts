import { debounce, normalizePath, TFile } from 'obsidian';
import type LMStudioNotesPlugin from './main';

/** Target size (chars) for an embedding chunk, and how many to send per request. */
const CHUNK_TARGET = 1000;
const MAX_CHUNKS_PER_FILE = 50;
const EMBED_BATCH = 16;

interface Chunk {
	text: string;
	/** L2-normalized embedding, so cosine similarity is a plain dot product. */
	vector: number[];
}

interface FileEntry {
	mtime: number;
	chunks: Chunk[];
}

interface IndexData {
	model: string;
	files: Record<string, FileEntry>;
}

export interface SearchHit {
	path: string;
	score: number;
	snippet: string;
}

export interface IndexStatus {
	built: boolean;
	model: string;
	files: number;
	chunks: number;
}

/**
 * A local, on-disk semantic index over the vault. Embeddings are produced by
 * LM Studio's `/v1/embeddings` endpoint, so nothing leaves the machine. The
 * index is stored as JSON in the plugin folder and maintained incrementally as
 * files change.
 */
export class SemanticIndex {
	private data: IndexData = { model: '', files: {} };
	private loaded = false;
	private busy = false;
	private dirty = new Set<string>();
	private flush = debounce(() => void this.processDirty(), 3000, true);

	constructor(private readonly plugin: LMStudioNotesPlugin) {}

	private get indexPath(): string {
		const dir = this.plugin.manifest.dir ?? '.';
		return normalizePath(`${dir}/semantic-index.json`);
	}

	async load(): Promise<void> {
		if (this.loaded) return;
		const adapter = this.plugin.app.vault.adapter;
		try {
			if (await adapter.exists(this.indexPath)) {
				const parsed = JSON.parse(await adapter.read(this.indexPath)) as Partial<IndexData>;
				if (parsed && typeof parsed === 'object' && parsed.files) {
					this.data = { model: parsed.model ?? '', files: parsed.files };
				}
			}
		} catch {
			this.data = { model: '', files: {} };
		}
		this.loaded = true;
	}

	private async save(): Promise<void> {
		await this.plugin.app.vault.adapter.write(this.indexPath, JSON.stringify(this.data));
	}

	status(): IndexStatus {
		const entries = Object.values(this.data.files);
		const chunks = entries.reduce((n, e) => n + e.chunks.length, 0);
		return { built: entries.length > 0, model: this.data.model, files: entries.length, chunks };
	}

	async isBuilt(): Promise<boolean> {
		await this.load();
		return this.status().built;
	}

	async clear(): Promise<void> {
		await this.load();
		this.data = { model: this.plugin.settings.embeddingModel, files: {} };
		await this.save();
	}

	/** Build (or rebuild) the entire index. */
	async rebuild(onProgress?: (done: number, total: number) => void): Promise<void> {
		const model = this.plugin.settings.embeddingModel;
		if (!model) throw new Error('No embedding model is set in the plugin settings.');
		await this.load();
		this.busy = true;
		try {
			const files = this.plugin.app.vault.getMarkdownFiles();
			this.data = { model, files: {} };
			let done = 0;
			for (const file of files) {
				await this.indexFile(file, false);
				onProgress?.(++done, files.length);
			}
			await this.save();
		} finally {
			this.busy = false;
		}
	}

	/** Embed and store a single file, skipping work when it is already current. */
	async indexFile(file: TFile, save = true): Promise<void> {
		const model = this.plugin.settings.embeddingModel;
		if (!model) return;

		const existing = this.data.files[file.path];
		if (existing && existing.mtime === file.stat.mtime && this.data.model === model) return;

		const content = await this.plugin.app.vault.cachedRead(file);
		const texts = chunkText(content);
		if (texts.length === 0) {
			if (this.data.files[file.path]) delete this.data.files[file.path];
			if (save) await this.save();
			return;
		}

		const vectors: number[][] = [];
		for (let i = 0; i < texts.length; i += EMBED_BATCH) {
			const embs = await this.plugin.client.embed(texts.slice(i, i + EMBED_BATCH), model);
			vectors.push(...embs);
		}

		this.data.model = model;
		this.data.files[file.path] = {
			mtime: file.stat.mtime,
			chunks: texts.map((text, i) => ({ text, vector: normalize(vectors[i] ?? []) })),
		};
		if (save) await this.save();
	}

	async search(query: string, limit: number): Promise<SearchHit[]> {
		const model = this.plugin.settings.embeddingModel;
		if (!model) throw new Error('No embedding model is set in the plugin settings.');
		await this.load();
		if (this.data.model && this.data.model !== model) {
			throw new Error(
				`The index was built with a different embedding model ("${this.data.model}"). Rebuild it from settings.`,
			);
		}

		const [queryVec] = await this.plugin.client.embed([query], model);
		if (!queryVec) return [];
		const q = normalize(queryVec);

		const hits: SearchHit[] = [];
		for (const [path, entry] of Object.entries(this.data.files)) {
			let best = -Infinity;
			let bestText = '';
			for (const c of entry.chunks) {
				const s = dot(q, c.vector);
				if (s > best) {
					best = s;
					bestText = c.text;
				}
			}
			if (best > -Infinity) {
				hits.push({ path, score: round(best), snippet: bestText.slice(0, 200) });
			}
		}
		hits.sort((a, b) => b.score - a.score);
		return hits.slice(0, limit);
	}

	// --- incremental maintenance (only once an index already exists) ---

	queueUpdate(file: TFile): void {
		if (!this.plugin.settings.semanticAutoIndex) return;
		this.dirty.add(file.path);
		this.flush();
	}

	queueRemove(path: string): void {
		if (!this.plugin.settings.semanticAutoIndex) return;
		this.dirty.add(path);
		this.flush();
	}

	private async processDirty(): Promise<void> {
		// Don't race a full rebuild; retry shortly after it finishes.
		if (this.busy) {
			this.flush();
			return;
		}
		await this.load();
		// Don't lazily build a partial index from change events — only maintain
		// an index the user has already built.
		if (this.status().files === 0) {
			this.dirty.clear();
			return;
		}
		const paths = [...this.dirty];
		this.dirty.clear();
		for (const path of paths) {
			const file = this.plugin.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile && file.extension === 'md') {
				await this.indexFile(file, false);
			} else if (this.data.files[path]) {
				delete this.data.files[path];
			}
		}
		await this.save();
	}
}

/** Split note text into ~CHUNK_TARGET-char chunks at paragraph boundaries. */
function chunkText(content: string): string[] {
	const body = content.replace(/^---\n[\s\S]*?\n---\n/, '');
	const paragraphs = body
		.split(/\n\s*\n/)
		.map((p) => p.trim())
		.filter(Boolean);

	const chunks: string[] = [];
	let current = '';
	for (const p of paragraphs) {
		if (current && current.length + p.length + 2 > CHUNK_TARGET) {
			chunks.push(current);
			current = '';
		}
		current = current ? `${current}\n\n${p}` : p;
		if (current.length >= CHUNK_TARGET) {
			chunks.push(current);
			current = '';
		}
	}
	if (current) chunks.push(current);
	return chunks.slice(0, MAX_CHUNKS_PER_FILE);
}

function normalize(v: number[]): number[] {
	let norm = 0;
	for (const x of v) norm += x * x;
	norm = Math.sqrt(norm) || 1;
	return v.map((x) => x / norm);
}

function dot(a: number[], b: number[]): number {
	const len = Math.min(a.length, b.length);
	let s = 0;
	for (let i = 0; i < len; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
	return s;
}

function round(n: number): number {
	return Math.round(n * 1000) / 1000;
}
