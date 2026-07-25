import { App, normalizePath } from 'obsidian';
import type LMStudioNotesPlugin from './main';
import type { SearchHit } from './semantic-index';

/**
 * Hybrid retrieval over the vault: keyword search and semantic (embedding)
 * search run independently, and their rankings are fused with Reciprocal Rank
 * Fusion (RRF). Keyword matching catches exact names, dates, and identifiers
 * that embeddings blur; embeddings catch paraphrases and topical matches that
 * keywords miss. RRF needs no score normalization or tuning, which makes it
 * robust across embedding models.
 *
 * This is deliberately deterministic — no "router" LLM deciding what context
 * to fetch. The embedding model IS the small model that decides relevance,
 * and it does so in milliseconds.
 */

const RRF_K = 60;
/** Cap on files whose content is read per keyword pass (protects huge vaults). */
const KEYWORD_SCAN_CAP = 2000;
/** How deep each ranked list goes into the fusion (relative to the ask). */
const FUSION_DEPTH_FACTOR = 3;

/** Common words to drop when turning a free-text message into search terms. */
const STOPWORDS = new Set([
	// English
	'the', 'and', 'for', 'with', 'that', 'this', 'from', 'what', 'when', 'where',
	'which', 'have', 'has', 'had', 'are', 'was', 'were', 'you', 'your', 'not',
	'all', 'can', 'could', 'how', 'who', 'why', 'will', 'would', 'should',
	'about', 'into', 'over', 'than', 'then', 'them', 'they', 'their', 'there',
	'here', 'out', 'our', 'its', 'also', 'just', 'like', 'some', 'any', 'get',
	'make', 'made', 'please', 'note', 'notes',
	// Italian
	'che', 'con', 'per', 'una', 'uno', 'del', 'della', 'delle', 'dei', 'gli',
	'come', 'cosa', 'questa', 'questo', 'quella', 'quello', 'sono', 'nella',
	'nel', 'più', 'anche', 'alla', 'dalla', 'mia', 'mio', 'tue', 'tuo',
]);

export interface KeywordHit {
	path: string;
	score: number;
	excerpt: string;
}

export interface RetrievedNote {
	path: string;
	/** Fused RRF score (comparable within one result set only). */
	score: number;
	/** Which signal(s) surfaced this note. */
	via: 'keyword' | 'semantic' | 'semantic+keyword';
	/** Best matching excerpt — a semantic chunk when available, else a keyword window. */
	excerpt: string;
	/** Heading of the best-matching chunk, when known. */
	heading?: string;
}

export interface RetrievalResult {
	notes: RetrievedNote[];
	/** False when the semantic index was unavailable and only keywords ran. */
	semanticUsed: boolean;
}

/** Turn free text into deduped search terms, most informative (longest) first. */
export function queryTerms(query: string): string[] {
	const words = query
		.toLowerCase()
		.split(/[^\p{L}\p{N}\-_]+/u)
		.filter((w) => w.length >= 3 && !STOPWORDS.has(w));
	return [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, 12);
}

/**
 * OR-style ranked keyword search. Any term can match, but notes matching more
 * DISTINCT terms rank far higher (so effective AND-matches float to the top),
 * with occurrence counts and path matches as tiebreakers.
 */
export async function keywordSearch(
	app: App,
	query: string,
	opts: { limit: number; folder?: string },
): Promise<{ hits: KeywordHit[]; capped: boolean }> {
	const terms = queryTerms(query);
	if (terms.length === 0) return { hits: [], capped: false };
	const prefix = opts.folder
		? `${normalizePath(opts.folder).replace(/\/+$/, '')}/`
		: null;

	let files = app.vault.getMarkdownFiles();
	if (prefix) files = files.filter((f) => f.path.startsWith(prefix));

	let scanned = 0;
	let capped = false;
	const hits: KeywordHit[] = [];

	for (const file of files) {
		if (scanned >= KEYWORD_SCAN_CAP) {
			capped = true;
			break;
		}
		scanned++;
		const pathLower = file.path.toLowerCase();
		const content = await app.vault.cachedRead(file);
		const lower = content.toLowerCase();

		let score = 0;
		let distinct = 0;
		let firstIdx = -1;
		for (const term of terms) {
			const inPath = pathLower.includes(term);
			let count = 0;
			let idx = lower.indexOf(term);
			if (idx !== -1 && firstIdx === -1) firstIdx = idx;
			while (idx !== -1 && count < 5) {
				count++;
				idx = lower.indexOf(term, idx + term.length);
			}
			if (count > 0 || inPath) distinct++;
			score += count + (inPath ? 5 : 0);
		}
		if (distinct === 0) continue;
		// Distinct-term coverage dominates raw frequency.
		score += distinct * 10;

		const excerpt =
			firstIdx === -1
				? '(matched path)'
				: content
						.slice(Math.max(0, firstIdx - 80), firstIdx + 240)
						.replace(/\s+/g, ' ')
						.trim();
		hits.push({ path: file.path, score, excerpt });
	}

	hits.sort((a, b) => b.score - a.score);
	return { hits: hits.slice(0, opts.limit), capped };
}

/**
 * Retrieve the notes most relevant to `query`, fusing keyword and semantic
 * rankings. Semantic search is best-effort: if the index isn't built or the
 * embedding call fails (model unloaded, server down), keyword results still
 * come back and `semanticUsed` reports false.
 */
export async function hybridRetrieve(
	plugin: LMStudioNotesPlugin,
	query: string,
	opts: { limit: number; folder?: string; excludePaths?: string[] },
): Promise<RetrievalResult> {
	const depth = Math.max(20, opts.limit * FUSION_DEPTH_FACTOR);
	const exclude = new Set(opts.excludePaths ?? []);

	const { hits: kwHits } = await keywordSearch(plugin.app, query, {
		limit: depth,
		folder: opts.folder,
	});

	let semHits: SearchHit[] = [];
	let semanticUsed = false;
	if (plugin.settings.embeddingModel && (await plugin.semanticIndex.isBuilt())) {
		try {
			semHits = await plugin.semanticIndex.search(query, depth);
			if (opts.folder) {
				const prefix = `${normalizePath(opts.folder).replace(/\/+$/, '')}/`;
				semHits = semHits.filter((h) => h.path.startsWith(prefix));
			}
			semanticUsed = true;
		} catch {
			// Retrieval must degrade, never block: fall back to keyword-only.
		}
	}

	interface Fused {
		path: string;
		rrf: number;
		kw?: KeywordHit;
		sem?: SearchHit;
	}
	const fused = new Map<string, Fused>();
	const add = (path: string): Fused => {
		let f = fused.get(path);
		if (!f) {
			f = { path, rrf: 0 };
			fused.set(path, f);
		}
		return f;
	};
	kwHits.forEach((h, i) => {
		const f = add(h.path);
		f.rrf += 1 / (RRF_K + i + 1);
		f.kw = h;
	});
	semHits.forEach((h, i) => {
		const f = add(h.path);
		f.rrf += 1 / (RRF_K + i + 1);
		f.sem = h;
	});

	const notes = [...fused.values()]
		.filter((f) => !exclude.has(f.path))
		.sort((a, b) => b.rrf - a.rrf)
		.slice(0, opts.limit)
		.map((f): RetrievedNote => ({
			path: f.path,
			score: Math.round(f.rrf * 1000) / 1000,
			via: f.sem && f.kw ? 'semantic+keyword' : f.sem ? 'semantic' : 'keyword',
			excerpt: f.sem?.text ?? f.kw?.excerpt ?? '',
			heading: f.sem?.heading,
		}));

	return { notes, semanticUsed };
}
