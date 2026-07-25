import { debounce, normalizePath, TFile } from 'obsidian';
import type LMStudioNotesPlugin from './main';

/** Target size (chars) for an embedding chunk, and how many to send per request. */
const CHUNK_TARGET = 1000;
const MAX_CHUNKS_PER_FILE = 50;
const EMBED_BATCH = 16;

/** On-disk format version. v2 packs vectors as base64 Float32 (smaller/faster). */
const INDEX_VERSION = 2;

interface Chunk {
	text: string;
	/** L2-normalized embedding, so cosine similarity is a plain dot product. */
	vector: Float32Array;
}

interface FileEntry {
	mtime: number;
	chunks: Chunk[];
}

/** Serialized forms. v1 stored `vector: number[]`; v2 stores `v: base64`. */
interface StoredChunkV2 {
	text: string;
	v: string;
}
interface StoredChunkV1 {
	text: string;
	vector?: number[];
}
interface StoredFileEntry {
	mtime: number;
	chunks: Array<StoredChunkV2 & StoredChunkV1>;
}
interface StoredIndex {
	version?: number;
	model: string;
	files: Record<string, StoredFileEntry>;
}

export interface SearchHit {
	path: string;
	score: number;
	/** Short preview of the best-matching chunk. */
	snippet: string;
	/** Full text of the best-matching chunk (~1k chars), for context injection. */
	text: string;
	/** Heading the best chunk sits under, when it has one. */
	heading?: string;
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
 * index is stored in the plugin folder — vectors packed as base64 Float32,
 * which is ~3x smaller and far faster to parse than JSON number arrays — and
 * maintained incrementally as files change.
 */
export class SemanticIndex {
	private model = '';
	private files = new Map<string, FileEntry>();
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
				const parsed = JSON.parse(await adapter.read(this.indexPath)) as Partial<StoredIndex>;
				if (parsed && typeof parsed === 'object' && parsed.files) {
					this.model = parsed.model ?? '';
					for (const [path, entry] of Object.entries(parsed.files)) {
						const chunks: Chunk[] = [];
						for (const c of entry.chunks) {
							if (typeof c.v === 'string') {
								chunks.push({ text: c.text, vector: decodeVector(c.v) });
							} else if (Array.isArray(c.vector)) {
								// v1 migration: numbers were already normalized on write.
								chunks.push({ text: c.text, vector: Float32Array.from(c.vector) });
							}
						}
						this.files.set(path, { mtime: entry.mtime, chunks });
					}
					// Persist migrated v1 data in the compact format.
					if ((parsed.version ?? 1) < INDEX_VERSION && this.files.size > 0) {
						await this.save();
					}
				}
			}
		} catch {
			this.model = '';
			this.files.clear();
		}
		this.loaded = true;
	}

	private async save(): Promise<void> {
		const files: Record<string, StoredFileEntry> = {};
		for (const [path, entry] of this.files) {
			files[path] = {
				mtime: entry.mtime,
				chunks: entry.chunks.map((c) => ({ text: c.text, v: encodeVector(c.vector) })),
			};
		}
		const data: StoredIndex = { version: INDEX_VERSION, model: this.model, files };
		await this.plugin.app.vault.adapter.write(this.indexPath, JSON.stringify(data));
	}

	status(): IndexStatus {
		let chunks = 0;
		for (const e of this.files.values()) chunks += e.chunks.length;
		return { built: this.files.size > 0, model: this.model, files: this.files.size, chunks };
	}

	async isBuilt(): Promise<boolean> {
		await this.load();
		return this.status().built;
	}

	async clear(): Promise<void> {
		await this.load();
		this.model = this.plugin.settings.embeddingModel;
		this.files.clear();
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
			this.model = model;
			this.files.clear();
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

		const existing = this.files.get(file.path);
		if (existing && existing.mtime === file.stat.mtime && this.model === model) return;

		const content = await this.plugin.app.vault.cachedRead(file);
		const texts = chunkText(content);
		if (texts.length === 0) {
			if (this.files.delete(file.path) && save) await this.save();
			return;
		}

		const vectors: number[][] = [];
		for (let i = 0; i < texts.length; i += EMBED_BATCH) {
			const embs = await this.plugin.client.embed(texts.slice(i, i + EMBED_BATCH), model);
			vectors.push(...embs);
		}

		this.model = model;
		this.files.set(file.path, {
			mtime: file.stat.mtime,
			chunks: texts.map((text, i) => ({ text, vector: normalize(vectors[i] ?? []) })),
		});
		if (save) await this.save();
	}

	async search(query: string, limit: number): Promise<SearchHit[]> {
		const model = this.plugin.settings.embeddingModel;
		if (!model) throw new Error('No embedding model is set in the plugin settings.');
		await this.load();
		if (this.model && this.model !== model) {
			throw new Error(
				`The index was built with a different embedding model ("${this.model}"). Rebuild it from settings.`,
			);
		}

		const [queryVec] = await this.plugin.client.embed([query], model);
		if (!queryVec) return [];
		const q = normalize(queryVec);

		const hits: SearchHit[] = [];
		for (const [path, entry] of this.files) {
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
				const headingMatch = /^#{1,6}\s+(.+)/.exec(bestText);
				hits.push({
					path,
					score: round(best),
					snippet: bestText.slice(0, 300),
					text: bestText,
					heading: headingMatch?.[1]?.trim(),
				});
			}
		}
		hits.sort((a, b) => b.score - a.score);
		return hits.slice(0, limit);
	}

	// --- incremental maintenance (only once an index already exists) ---

	/**
	 * Reconciliation sweep: diff every markdown file's mtime against the index
	 * and queue whatever is stale — edits made while Obsidian was closed,
	 * deletions from another device, and files whose earlier embedding attempt
	 * failed because LM Studio wasn't running. Comparing mtimes is near-free;
	 * only actual mismatches cost an embedding call. Safe to run often.
	 */
	async reconcile(): Promise<void> {
		const model = this.plugin.settings.embeddingModel;
		if (!this.plugin.settings.semanticAutoIndex || !model) return;
		if (this.busy) return;
		// Stay off the server while a chat/summarize generation is running; the
		// post-generation reconcile (and the periodic tick) will catch up.
		if (this.plugin.activeGenerations > 0) return;
		await this.load();
		// Only maintain an index the user has built, and never mix models —
		// a model switch needs an explicit rebuild from settings.
		if (this.files.size === 0) return;
		if (this.model && this.model !== model) return;

		const seen = new Set<string>();
		for (const f of this.plugin.app.vault.getMarkdownFiles()) {
			seen.add(f.path);
			const entry = this.files.get(f.path);
			if (!entry || entry.mtime !== f.stat.mtime) this.dirty.add(f.path);
		}
		for (const path of this.files.keys()) {
			if (!seen.has(path)) this.dirty.add(path);
		}
		if (this.dirty.size > 0) this.flush();
	}

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
		// Never embed while a generation is in flight: a note created/edited by a
		// chat tool call would otherwise trigger an embedding request mid-turn,
		// which on JIT-auto-evict LM Studio setups unloads the chat model and
		// fails the conversation. Re-schedule and try again after it finishes.
		if (this.plugin.activeGenerations > 0) {
			this.flush();
			return;
		}
		await this.load();
		// Don't lazily build a partial index from change events — only maintain
		// an index the user has already built.
		if (this.files.size === 0) {
			this.dirty.clear();
			return;
		}
		const paths = [...this.dirty];
		this.dirty.clear();
		let changed = false;
		for (let i = 0; i < paths.length; i++) {
			const path = paths[i]!;
			const file = this.plugin.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile && file.extension === 'md') {
				try {
					await this.indexFile(file, false);
					changed = true;
				} catch {
					// Embedding unavailable (LM Studio closed / embedder unloaded).
					// Requeue this and every remaining path so nothing is lost, and
					// stop — the periodic reconcile sweep retries once it's back.
					for (let j = i; j < paths.length; j++) this.dirty.add(paths[j]!);
					break;
				}
			} else if (this.files.delete(path)) {
				changed = true;
			}
		}
		if (changed) await this.save();
	}
}

/**
 * Split note text into ~CHUNK_TARGET-char chunks. Sections are cut at heading
 * boundaries first (so a chunk never straddles unrelated topics), then packed
 * at paragraph boundaries; the section's heading is kept at the start of each
 * of its chunks, which measurably helps retrieval on terse notes.
 */
function chunkText(content: string): string[] {
	const body = content.replace(/^---\n[\s\S]*?\n---\n/, '');
	const sections = body.split(/\n(?=#{1,6}\s)/);

	const chunks: string[] = [];
	for (const section of sections) {
		const headingMatch = /^(#{1,6}\s[^\n]*)\n?/.exec(section);
		const heading = headingMatch ? headingMatch[1]!.trim() : '';
		const rest = headingMatch ? section.slice(headingMatch[0].length) : section;
		const paragraphs = rest
			.split(/\n\s*\n/)
			.map((p) => p.trim())
			.filter(Boolean);

		const prefix = heading ? `${heading}\n` : '';
		let current = '';
		const push = () => {
			if (current) chunks.push(prefix + current);
			current = '';
		};
		for (const p of paragraphs) {
			if (current && current.length + p.length + 2 > CHUNK_TARGET) push();
			current = current ? `${current}\n\n${p}` : p;
			if (current.length >= CHUNK_TARGET) push();
		}
		push();
		if (!paragraphs.length && heading) chunks.push(heading);
		if (chunks.length >= MAX_CHUNKS_PER_FILE) break;
	}
	return chunks.slice(0, MAX_CHUNKS_PER_FILE);
}

function normalize(v: ArrayLike<number>): Float32Array {
	const out = Float32Array.from(v as number[]);
	let norm = 0;
	for (let i = 0; i < out.length; i++) norm += out[i]! * out[i]!;
	norm = Math.sqrt(norm) || 1;
	for (let i = 0; i < out.length; i++) out[i] = out[i]! / norm;
	return out;
}

function dot(a: Float32Array, b: Float32Array): number {
	const len = Math.min(a.length, b.length);
	let s = 0;
	for (let i = 0; i < len; i++) s += a[i]! * b[i]!;
	return s;
}

function round(n: number): number {
	return Math.round(n * 1000) / 1000;
}

/** Pack a Float32 vector as base64 (little-endian bytes of its buffer). */
function encodeVector(v: Float32Array): string {
	const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
	let bin = '';
	const STEP = 0x8000; // keep String.fromCharCode argument counts sane
	for (let i = 0; i < bytes.length; i += STEP) {
		bin += String.fromCharCode(...bytes.subarray(i, i + STEP));
	}
	return btoa(bin);
}

function decodeVector(s: string): Float32Array {
	const bin = atob(s);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new Float32Array(bytes.buffer);
}
