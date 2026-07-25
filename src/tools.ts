import { App, getAllTags, MarkdownView, normalizePath, TFile } from 'obsidian';
import type LMStudioNotesPlugin from './main';
import { ToolCall, ToolDef } from './lmstudio';
import {
	findMarkdownViewForFile,
	getActiveNote,
	insertIntoNote,
	InsertLocation,
} from './note-context';
import { LMStudioNotesSettings } from './settings';
import { lineDiff } from './diff';
import { hybridRetrieve } from './retrieval';
import type { ConfirmRequest } from './confirm-modal';

/** How much note text a read tool returns at most, to protect the context window. */
const TOOL_MAX_CHARS = 16_000;

export interface ToolContext {
	app: App;
	plugin: LMStudioNotesPlugin;
}

/** A previewable edit: before/after text plus the action that applies it. */
export interface EditPlan {
	/** Human-readable target, e.g. the note path. */
	label: string;
	before: string;
	after: string;
	/** Perform the edit and return the tool-result message. */
	apply(): Promise<string>;
}

export interface Tool {
	def: ToolDef;
	/** Whether the tool mutates the vault (gated by settings + confirmation). */
	write: boolean;
	/** Optional gate: when present and false, the tool is not advertised. */
	enabled?(settings: LMStudioNotesSettings): boolean;
	/** Human-readable description of the pending action, for the simple confirm path. */
	describe?(args: Record<string, unknown>): string;
	/** Compute a diff-previewable plan; return a string to signal an error. */
	plan?(ctx: ToolContext, args: Record<string, unknown>): Promise<EditPlan | string>;
	/** Run directly (reads, and writes that aren't diff-previewed). */
	run?(ctx: ToolContext, args: Record<string, unknown>): Promise<string>;
}

// --- small arg/helpers -----------------------------------------------------

function str(args: Record<string, unknown>, key: string): string | undefined {
	const v = args[key];
	return typeof v === 'string' ? v : undefined;
}

function num(args: Record<string, unknown>, key: string): number | undefined {
	const v = args[key];
	return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function clampInt(n: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Math.floor(n)));
}

/** Reduce any value to a string for loose equality matching. */
function toComparable(v: unknown): string {
	if (v === null || v === undefined) return '';
	if (typeof v === 'string') return v;
	if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
		return String(v);
	}
	return JSON.stringify(v) ?? '';
}

/** All tags on a file (inline + frontmatter), each with a leading '#'. */
function tagsFor(app: App, file: TFile): string[] {
	const cache = app.metadataCache.getFileCache(file);
	return cache ? (getAllTags(cache) ?? []) : [];
}

function clampContent(s: string): string {
	return s.length <= TOOL_MAX_CHARS
		? s
		: `${s.slice(0, TOOL_MAX_CHARS)}\n…[truncated, note is longer]`;
}

function preview(text: string | undefined): string {
	if (!text) return '(empty)';
	return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

function ensureMd(path: string): string {
	return /\.md$/i.test(path) ? path : `${path}.md`;
}

/** Literal (non-regex) find/replace so `$` and friends aren't interpreted. */
function applyReplace(data: string, find: string, replace: string, all: boolean): string {
	if (all) return data.split(find).join(replace);
	const idx = data.indexOf(find);
	if (idx === -1) return data;
	return data.slice(0, idx) + replace + data.slice(idx + find.length);
}

/** Resolve a vault-relative path or a note name/link to a file (for reads). */
function resolveFile(app: App, path: string): TFile | null {
	const direct = app.vault.getAbstractFileByPath(normalizePath(path));
	if (direct instanceof TFile) return direct;
	return app.metadataCache.getFirstLinkpathDest(path, '');
}

/**
 * Resolve strictly by exact vault path (for WRITES). We deliberately do not
 * fall back to fuzzy link resolution here: a bare basename shared by several
 * notes could otherwise be edited in the wrong file.
 */
function resolveFileStrict(app: App, path: string): TFile | null {
	const direct = app.vault.getAbstractFileByPath(normalizePath(path));
	return direct instanceof TFile ? direct : null;
}

// --- tool definitions ------------------------------------------------------

const objectSchema = (
	properties: Record<string, unknown>,
	required: string[] = [],
): Record<string, unknown> => ({
	type: 'object',
	properties,
	required,
	additionalProperties: false,
});

export const ALL_TOOLS: Record<string, Tool> = {
	get_active_note: {
		write: false,
		def: {
			type: 'function',
			function: {
				name: 'get_active_note',
				description:
					'Return the note currently open in the active pane, including its path and any selected text. Use this when the user refers to "this note" or "the current note".',
				parameters: objectSchema({}),
			},
		},
		run: async ({ app }) => {
			const note = await getActiveNote(app);
			if (!note) return 'No note is currently open in the active pane.';
			return JSON.stringify({
				path: note.file.path,
				basename: note.file.basename,
				hasSelection: note.selection.length > 0,
				selection: note.selection || null,
				content: clampContent(note.content),
			});
		},
	},

	read_note: {
		write: false,
		def: {
			type: 'function',
			function: {
				name: 'read_note',
				description:
					'Read the content of a note by its vault path or name. For long notes, pass "heading" to read just one section (see get_note_outline), or "offset" to continue reading where a truncated read stopped (use the returned nextOffset).',
				parameters: objectSchema(
					{
						path: {
							type: 'string',
							description: 'Vault-relative path or note name, e.g. "Folder/Note.md" or "Note".',
						},
						heading: {
							type: 'string',
							description: 'Optional heading whose section to read (exact text, case-insensitive).',
						},
						offset: {
							type: 'number',
							description: 'Optional character offset to start reading from (default 0).',
						},
					},
					['path'],
				),
			},
		},
		run: async ({ app }, args) => {
			const path = str(args, 'path');
			if (!path) return 'Error: missing "path".';
			const file = resolveFile(app, path);
			if (!file) return `Note not found: ${path}`;
			const content = await app.vault.cachedRead(file);

			let body = content;
			const heading = str(args, 'heading');
			if (heading) {
				const headings = app.metadataCache.getFileCache(file)?.headings ?? [];
				const idx = headings.findIndex(
					(h) => h.heading.toLowerCase() === heading.toLowerCase(),
				);
				if (idx === -1) {
					return JSON.stringify({
						path: file.path,
						error: `Heading not found: "${heading}"`,
						headings: headings.map((h) => h.heading),
					});
				}
				const start = headings[idx]!.position.start.offset;
				let end = content.length;
				for (let j = idx + 1; j < headings.length; j++) {
					if (headings[j]!.level <= headings[idx]!.level) {
						end = headings[j]!.position.start.offset;
						break;
					}
				}
				body = content.slice(start, end);
			}

			const offset = clampInt(num(args, 'offset') ?? 0, 0, Math.max(0, body.length));
			const slice = body.slice(offset, offset + TOOL_MAX_CHARS);
			const truncated = offset + slice.length < body.length;
			return JSON.stringify({
				path: file.path,
				...(heading ? { heading } : {}),
				length: body.length,
				...(offset > 0 ? { offset } : {}),
				truncated,
				...(truncated ? { nextOffset: offset + slice.length } : {}),
				content: slice,
			});
		},
	},

	search_notes: {
		write: false,
		def: {
			type: 'function',
			function: {
				name: 'search_notes',
				description:
					'Search the vault for notes matching a query. Combines exact keyword matching with semantic (meaning-based) search over the local embedding index, ranked together. Works for exact words AND descriptions of a topic. Returns the best-matching excerpt per note; use read_note for full content. Use short, specific queries.',
				parameters: objectSchema(
					{
						query: { type: 'string', description: 'What to search for (keywords or a topic).' },
						folder: {
							type: 'string',
							description: 'Optional folder path to search within, e.g. "Journal/Weekly".',
						},
						limit: { type: 'number', description: 'Max results (default 8, max 30).' },
					},
					['query'],
				),
			},
		},
		run: async ({ plugin }, args) => {
			const query = str(args, 'query');
			if (!query) return 'Error: missing "query".';
			const limit = clampInt(num(args, 'limit') ?? 8, 1, 30);
			const folder = str(args, 'folder');
			const { notes, semanticUsed } = await hybridRetrieve(plugin, query, {
				limit,
				folder,
			});
			return JSON.stringify({
				query,
				...(folder ? { folder } : {}),
				semantic: semanticUsed,
				count: notes.length,
				results: notes.map((n) => ({
					path: n.path,
					via: n.via,
					...(n.heading ? { heading: n.heading } : {}),
					excerpt: n.excerpt.slice(0, 400),
				})),
			});
		},
	},

	list_vault_notes: {
		write: false,
		def: {
			type: 'function',
			function: {
				name: 'list_vault_notes',
				description:
					'List markdown note paths in the vault, optionally within a folder, sorted by name or by last modified (newest first).',
				parameters: objectSchema({
					folder: {
						type: 'string',
						description: 'Optional folder path to list, e.g. "Projects". Omit for the whole vault.',
					},
					sort: {
						type: 'string',
						enum: ['name', 'modified'],
						description: 'Sort order (default "name"; "modified" = newest first).',
					},
					limit: { type: 'number', description: 'Max paths to return (default 100, max 500).' },
				}),
			},
		},
		run: async ({ app }, args) => {
			const limit = clampInt(num(args, 'limit') ?? 100, 1, 500);
			const folder = str(args, 'folder');
			const prefix = folder ? `${normalizePath(folder).replace(/\/+$/, '')}/` : null;
			const sort = str(args, 'sort') === 'modified' ? 'modified' : 'name';

			let files = app.vault.getMarkdownFiles();
			if (prefix) files = files.filter((f) => f.path.startsWith(prefix));
			const total = files.length;
			files = files
				.slice()
				.sort((a, b) =>
					sort === 'modified' ? b.stat.mtime - a.stat.mtime : a.path.localeCompare(b.path),
				);
			const paths = files.slice(0, limit).map((f) => f.path);
			return JSON.stringify({
				total,
				count: paths.length,
				...(folder ? { folder } : {}),
				sort,
				paths,
			});
		},
	},

	get_note_links: {
		write: false,
		def: {
			type: 'function',
			function: {
				name: 'get_note_links',
				description:
					"Get a note's outgoing links, backlinks (notes that link to it), and unresolved (broken) links.",
				parameters: objectSchema(
					{ path: { type: 'string', description: 'Vault path or note name.' } },
					['path'],
				),
			},
		},
		run: async ({ app }, args) => {
			const path = str(args, 'path');
			if (!path) return 'Error: missing "path".';
			const file = resolveFile(app, path);
			if (!file) return `Note not found: ${path}`;

			const resolved = app.metadataCache.resolvedLinks;
			const outgoing = Object.entries(resolved[file.path] ?? {}).map(
				([p, count]) => ({ path: p, count }),
			);
			const backlinks: Array<{ path: string; count: number }> = [];
			for (const [src, targets] of Object.entries(resolved)) {
				const count = targets[file.path];
				if (count) backlinks.push({ path: src, count });
			}
			const unresolved = Object.keys(
				app.metadataCache.unresolvedLinks[file.path] ?? {},
			);
			return JSON.stringify({ path: file.path, outgoing, backlinks, unresolved });
		},
	},

	find_related_notes: {
		write: false,
		def: {
			type: 'function',
			function: {
				name: 'find_related_notes',
				description:
					'Find notes related to a given note, ranked by shared links (in or out) and shared tags.',
				parameters: objectSchema(
					{
						path: { type: 'string', description: 'Vault path or note name.' },
						limit: { type: 'number', description: 'Max results (default 10, max 30).' },
					},
					['path'],
				),
			},
		},
		run: async ({ app }, args) => {
			const path = str(args, 'path');
			if (!path) return 'Error: missing "path".';
			const file = resolveFile(app, path);
			if (!file) return `Note not found: ${path}`;
			const limit = clampInt(num(args, 'limit') ?? 10, 1, 30);

			const resolved = app.metadataCache.resolvedLinks;
			const score = new Map<string, number>();
			const add = (p: string, w: number) => {
				if (p !== file.path) score.set(p, (score.get(p) ?? 0) + w);
			};
			for (const p of Object.keys(resolved[file.path] ?? {})) add(p, 2);
			for (const [src, targets] of Object.entries(resolved)) {
				if (targets[file.path]) add(src, 2);
			}
			const targetTags = new Set(tagsFor(app, file));
			if (targetTags.size) {
				for (const f of app.vault.getMarkdownFiles()) {
					if (f.path === file.path) continue;
					let shared = 0;
					for (const t of tagsFor(app, f)) if (targetTags.has(t)) shared++;
					if (shared) add(f.path, shared);
				}
			}

			const related = [...score.entries()]
				.sort((a, b) => b[1] - a[1])
				.slice(0, limit)
				.map(([p, s]) => ({ path: p, score: s }));
			return JSON.stringify({ path: file.path, related });
		},
	},

	get_note_outline: {
		write: false,
		def: {
			type: 'function',
			function: {
				name: 'get_note_outline',
				description: 'Get the heading outline (structure) of a note.',
				parameters: objectSchema(
					{ path: { type: 'string', description: 'Vault path or note name.' } },
					['path'],
				),
			},
		},
		run: async ({ app }, args) => {
			const path = str(args, 'path');
			if (!path) return 'Error: missing "path".';
			const file = resolveFile(app, path);
			if (!file) return `Note not found: ${path}`;
			const headings = (app.metadataCache.getFileCache(file)?.headings ?? []).map(
				(h) => ({ level: h.level, heading: h.heading }),
			);
			return JSON.stringify({ path: file.path, headings });
		},
	},

	find_notes_by_tag: {
		write: false,
		def: {
			type: 'function',
			function: {
				name: 'find_notes_by_tag',
				description:
					'List notes that have a given tag (with or without the leading #). Matches nested tags too (e.g. "project" matches "project/x").',
				parameters: objectSchema(
					{
						tag: { type: 'string', description: 'Tag to match, e.g. "project" or "#project".' },
						limit: { type: 'number', description: 'Max results (default 50, max 200).' },
					},
					['tag'],
				),
			},
		},
		run: async ({ app }, args) => {
			const raw = str(args, 'tag');
			if (!raw) return 'Error: missing "tag".';
			const tag = raw.startsWith('#') ? raw : `#${raw}`;
			const limit = clampInt(num(args, 'limit') ?? 50, 1, 200);
			const notes: string[] = [];
			for (const f of app.vault.getMarkdownFiles()) {
				if (notes.length >= limit) break;
				if (tagsFor(app, f).some((t) => t === tag || t.startsWith(`${tag}/`))) {
					notes.push(f.path);
				}
			}
			return JSON.stringify({ tag, count: notes.length, notes });
		},
	},

	find_notes_by_property: {
		write: false,
		def: {
			type: 'function',
			function: {
				name: 'find_notes_by_property',
				description:
					'List notes whose YAML frontmatter contains a given key, optionally matching a value.',
				parameters: objectSchema(
					{
						key: { type: 'string', description: 'Frontmatter key, e.g. "status".' },
						value: { description: 'Optional value to match (string/number/boolean).' },
						limit: { type: 'number', description: 'Max results (default 50, max 200).' },
					},
					['key'],
				),
			},
		},
		run: async ({ app }, args) => {
			const key = str(args, 'key');
			if (!key) return 'Error: missing "key".';
			const want = 'value' in args ? toComparable(args.value) : null;
			const limit = clampInt(num(args, 'limit') ?? 50, 1, 200);
			const notes: Array<{ path: string; value: unknown }> = [];
			for (const f of app.vault.getMarkdownFiles()) {
				if (notes.length >= limit) break;
				const fm = app.metadataCache.getFileCache(f)?.frontmatter;
				if (!fm || !(key in fm)) continue;
				const v: unknown = fm[key];
				if (want !== null) {
					const ok = Array.isArray(v)
						? v.some((x: unknown) => toComparable(x) === want)
						: toComparable(v) === want;
					if (!ok) continue;
				}
				notes.push({ path: f.path, value: v });
			}
			return JSON.stringify({ key, count: notes.length, notes });
		},
	},

	get_recent_notes: {
		write: false,
		def: {
			type: 'function',
			function: {
				name: 'get_recent_notes',
				description: 'List the most recently modified notes.',
				parameters: objectSchema({
					limit: { type: 'number', description: 'Max notes (default 10, max 50).' },
				}),
			},
		},
		run: async ({ app }, args) => {
			const limit = clampInt(num(args, 'limit') ?? 10, 1, 50);
			const notes = app.vault
				.getMarkdownFiles()
				.sort((a, b) => b.stat.mtime - a.stat.mtime)
				.slice(0, limit)
				.map((f) => ({ path: f.path, modified: new Date(f.stat.mtime).toISOString() }));
			return JSON.stringify({ count: notes.length, notes });
		},
	},

	replace_selection: {
		write: true,
		def: {
			type: 'function',
			function: {
				name: 'replace_selection',
				description:
					'Replace the currently selected text in the active editor with new text. Fails if nothing is selected.',
				parameters: objectSchema(
					{ text: { type: 'string', description: 'Replacement text.' } },
					['text'],
				),
			},
		},
		plan: async ({ app }, args) => {
			const text = str(args, 'text');
			if (text === undefined) return 'Error: missing "text".';
			const view = app.workspace.getActiveViewOfType(MarkdownView);
			if (!view) return 'Error: no active markdown editor.';
			const editor = view.editor;
			const selection = editor.getSelection();
			if (!selection) return 'Error: nothing is selected in the active editor.';
			return {
				label: `${view.file?.path ?? 'active note'} (selection)`,
				before: selection,
				after: text,
				apply: () => {
					editor.replaceSelection(text);
					return Promise.resolve('Replaced the selection.');
				},
			};
		},
	},

	insert_into_active_note: {
		write: true,
		def: {
			type: 'function',
			function: {
				name: 'insert_into_active_note',
				description: 'Insert text into the active note at the top, bottom, or cursor.',
				parameters: objectSchema(
					{
						text: { type: 'string', description: 'Text to insert.' },
						location: {
							type: 'string',
							enum: ['top', 'bottom', 'cursor'],
							description: 'Where to insert (default cursor).',
						},
					},
					['text'],
				),
			},
		},
		describe: (args) =>
			`Insert into the active note (${str(args, 'location') ?? 'cursor'}):\n\n${preview(str(args, 'text'))}`,
		run: async ({ app }, args) => {
			const text = str(args, 'text');
			if (text === undefined) return 'Error: missing "text".';
			const note = await getActiveNote(app);
			if (!note) return 'Error: no active note.';
			const loc = str(args, 'location');
			const location: InsertLocation =
				loc === 'top' || loc === 'bottom' || loc === 'cursor' ? loc : 'cursor';
			await insertIntoNote(app, note, text, location);
			return `Inserted text at ${location} of "${note.file.basename}".`;
		},
	},

	append_to_note: {
		write: true,
		def: {
			type: 'function',
			function: {
				name: 'append_to_note',
				description: 'Append text to the end of a note identified by path or name.',
				parameters: objectSchema(
					{
						path: { type: 'string', description: 'Vault path or note name.' },
						text: { type: 'string', description: 'Text to append.' },
					},
					['path', 'text'],
				),
			},
		},
		plan: async ({ app }, args) => {
			const path = str(args, 'path');
			const text = str(args, 'text');
			if (!path || text === undefined) return 'Error: missing "path" or "text".';
			const file = resolveFileStrict(app, path);
			if (!file) {
				return `No note at exact path "${path}". Provide the full vault path, e.g. "Folder/Note.md".`;
			}
			const before = await app.vault.read(file);
			const appended = text.startsWith('\n') ? text : `\n${text}`;
			return {
				label: file.path,
				before,
				after: before + appended,
				apply: async () => {
					await app.vault.append(file, appended);
					return `Appended to "${file.path}".`;
				},
			};
		},
	},

	update_frontmatter: {
		write: true,
		def: {
			type: 'function',
			function: {
				name: 'update_frontmatter',
				description:
					"Set a single key in a note's YAML frontmatter, creating it if absent. Replaces any existing value for that key (no merge).",
				parameters: objectSchema(
					{
						path: { type: 'string', description: 'Vault path or note name.' },
						key: { type: 'string', description: 'Frontmatter key to set.' },
						value: { description: 'New value (string, number, boolean, or array).' },
					},
					['path', 'key', 'value'],
				),
			},
		},
		describe: (args) =>
			`Set frontmatter "${str(args, 'key')}" = ${JSON.stringify(args.value)} in "${str(args, 'path')}" (replaces any existing value).`,
		run: async ({ app }, args) => {
			const path = str(args, 'path');
			const key = str(args, 'key');
			if (!path || !key) return 'Error: missing "path" or "key".';
			const file = resolveFileStrict(app, path);
			if (!file) {
				return `No note at exact path "${path}". Provide the full vault path, e.g. "Folder/Note.md".`;
			}
			try {
				await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
					fm[key] = args.value;
				});
			} catch (e) {
				return `Error updating frontmatter: ${(e as Error).message}`;
			}
			return `Updated frontmatter "${key}" in "${file.path}".`;
		},
	},

	create_note: {
		write: true,
		def: {
			type: 'function',
			function: {
				name: 'create_note',
				description: 'Create a new note at the given path. Fails if a file already exists there.',
				parameters: objectSchema(
					{
						path: { type: 'string', description: 'Vault path for the new note (".md" added if missing).' },
						content: { type: 'string', description: 'Initial note content (optional).' },
					},
					['path'],
				),
			},
		},
		plan: async ({ app }, args) => {
			const rawPath = str(args, 'path');
			if (!rawPath) return 'Error: missing "path".';
			const path = normalizePath(ensureMd(rawPath));
			if (app.vault.getAbstractFileByPath(path)) return `A file already exists at ${path}.`;
			const content = str(args, 'content') ?? '';
			return {
				label: path,
				before: '',
				after: content,
				apply: async () => {
					const folder = path.split('/').slice(0, -1).join('/');
					if (folder && !app.vault.getAbstractFileByPath(folder)) {
						await app.vault.createFolder(folder);
					}
					const file = await app.vault.create(path, content);
					return `Created note "${file.path}".`;
				},
			};
		},
	},

	replace_in_note: {
		write: true,
		def: {
			type: 'function',
			function: {
				name: 'replace_in_note',
				description:
					'Find and replace exact text in a note by path — the note does NOT need to be open. Use this to edit or REMOVE content anywhere in any note (e.g. delete task lines that were moved elsewhere). Read the note first to get the exact text; include trailing newlines to delete whole lines. Replace with an empty string to delete the matched text.',
				parameters: objectSchema(
					{
						path: { type: 'string', description: 'Vault path of the note to edit.' },
						find: { type: 'string', description: 'Exact text to find (verbatim, not a pattern).' },
						replace: {
							type: 'string',
							description: 'Replacement text. Use an empty string to delete the matched text.',
						},
						all: {
							type: 'boolean',
							description: 'Replace every occurrence (default false = first match only).',
						},
					},
					['path', 'find'],
				),
			},
		},
		plan: async ({ app }, args) => {
			const path = str(args, 'path');
			const find = str(args, 'find');
			if (!path || find === undefined) return 'Error: missing "path" or "find".';
			if (find === '') return 'Error: "find" must not be empty.';
			const replace = str(args, 'replace') ?? '';
			const all = args.all === true;

			const file = resolveFileStrict(app, path);
			if (!file) {
				return `No note at exact path "${path}". Provide the full vault path, e.g. "Folder/Note.md".`;
			}

			// Prefer the live editor when the note is open (undoable, respects
			// unsaved edits); otherwise read/write the file directly.
			const view = findMarkdownViewForFile(app, file);
			const before = view ? view.editor.getValue() : await app.vault.read(file);
			if (!before.includes(find)) {
				return `Text not found in "${file.path}". Read the note to get the exact text.`;
			}
			const after = applyReplace(before, find, replace, all);
			const count = all ? before.split(find).length - 1 : 1;
			return {
				label: file.path,
				before,
				after,
				apply: async () => {
					if (view) {
						const current = view.editor.getValue();
						if (!current.includes(find)) {
							return `Text not found in "${file.path}" (it changed). Re-read and try again.`;
						}
						view.editor.setValue(applyReplace(current, find, replace, all));
					} else {
						await app.vault.process(file, (data) =>
							data.includes(find) ? applyReplace(data, find, replace, all) : data,
						);
					}
					return `Replaced ${count} occurrence(s) in "${file.path}".`;
				},
			};
		},
	},

	move_note: {
		write: true,
		def: {
			type: 'function',
			function: {
				name: 'move_note',
				description:
					'Move or rename a note to a new vault path. Links pointing at the note are updated automatically. Folders in the new path are created if needed.',
				parameters: objectSchema(
					{
						path: { type: 'string', description: 'Exact current vault path of the note.' },
						new_path: {
							type: 'string',
							description: 'New vault path (".md" added if missing), e.g. "Archive/Old note.md".',
						},
					},
					['path', 'new_path'],
				),
			},
		},
		describe: (args) => `Move "${str(args, 'path')}" to "${str(args, 'new_path')}".`,
		run: async ({ app }, args) => {
			const path = str(args, 'path');
			const newPathRaw = str(args, 'new_path');
			if (!path || !newPathRaw) return 'Error: missing "path" or "new_path".';
			const file = resolveFileStrict(app, path);
			if (!file) {
				return `No note at exact path "${path}". Provide the full vault path, e.g. "Folder/Note.md".`;
			}
			const newPath = normalizePath(ensureMd(newPathRaw));
			if (app.vault.getAbstractFileByPath(newPath)) {
				return `A file already exists at ${newPath}.`;
			}
			const folder = newPath.split('/').slice(0, -1).join('/');
			if (folder && !app.vault.getAbstractFileByPath(folder)) {
				await app.vault.createFolder(folder);
			}
			await app.fileManager.renameFile(file, newPath);
			return `Moved "${path}" to "${newPath}" (links updated).`;
		},
	},

	delete_note: {
		write: true,
		def: {
			type: 'function',
			function: {
				name: 'delete_note',
				description:
					'Move a note to the trash (recoverable — NOT a permanent delete). Requires the exact vault path.',
				parameters: objectSchema(
					{ path: { type: 'string', description: 'Exact vault path of the note to trash.' } },
					['path'],
				),
			},
		},
		describe: (args) => `Move "${str(args, 'path')}" to the trash.`,
		run: async ({ app }, args) => {
			const path = str(args, 'path');
			if (!path) return 'Error: missing "path".';
			const file = resolveFileStrict(app, path);
			if (!file) {
				return `No note at exact path "${path}". Provide the full vault path, e.g. "Folder/Note.md".`;
			}
			await app.fileManager.trashFile(file);
			return `Moved "${file.path}" to the trash.`;
		},
	},
};

export type ToolGroup = 'Reading' | 'Search' | 'Graph' | 'Editing';
export const TOOL_GROUPS: ToolGroup[] = ['Reading', 'Search', 'Graph', 'Editing'];

/** Which group each tool belongs to (for the enable/disable UI). */
const TOOL_GROUP_MAP: Record<string, ToolGroup> = {
	get_active_note: 'Reading',
	read_note: 'Reading',
	list_vault_notes: 'Reading',
	get_recent_notes: 'Reading',
	search_notes: 'Search',
	get_note_links: 'Graph',
	find_related_notes: 'Graph',
	get_note_outline: 'Graph',
	find_notes_by_tag: 'Graph',
	find_notes_by_property: 'Graph',
	replace_selection: 'Editing',
	insert_into_active_note: 'Editing',
	append_to_note: 'Editing',
	update_frontmatter: 'Editing',
	create_note: 'Editing',
	replace_in_note: 'Editing',
	move_note: 'Editing',
	delete_note: 'Editing',
};

export const ALL_TOOL_NAMES = Object.keys(ALL_TOOLS);
export const EDITING_TOOL_NAMES = Object.entries(ALL_TOOLS)
	.filter(([, t]) => t.write)
	.map(([name]) => name);

export interface ToolCatalogEntry {
	name: string;
	label: string;
	group: ToolGroup;
	write: boolean;
	/** False when a precondition is unmet (e.g. semantic search with no model). */
	available: boolean;
}

export function toolCatalog(settings: LMStudioNotesSettings): ToolCatalogEntry[] {
	return Object.entries(ALL_TOOLS).map(([name, t]) => ({
		name,
		label: prettifyToolName(name),
		group: TOOL_GROUP_MAP[name] ?? 'Reading',
		write: t.write,
		available: t.enabled ? t.enabled(settings) : true,
	}));
}

function prettifyToolName(name: string): string {
	const s = name.replace(/_/g, ' ');
	return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The tool definitions to advertise to the model, honoring enable/disable settings. */
export function toolDefsFor(settings: LMStudioNotesSettings): ToolDef[] {
	const disabled = new Set(settings.disabledTools);
	return Object.entries(ALL_TOOLS)
		.filter(([name]) => !disabled.has(name))
		.filter(([, t]) => (t.enabled ? t.enabled(settings) : true))
		.map(([, t]) => t.def);
}

export interface ToolRunOptions {
	confirm: (req: ConfirmRequest) => Promise<boolean>;
}

/**
 * Execute a model-requested tool call. Always resolves to a string (never
 * throws) so the conversation loop can hand the result back to the model.
 */
export async function executeTool(
	ctx: ToolContext,
	call: ToolCall,
	opts: ToolRunOptions,
): Promise<string> {
	const tool = ALL_TOOLS[call.function.name];
	if (!tool) return `Error: unknown tool "${call.function.name}".`;

	let parsed: unknown = {};
	try {
		parsed = call.function.arguments
			? (JSON.parse(call.function.arguments) as unknown)
			: {};
	} catch {
		return 'Error: tool arguments were not valid JSON.';
	}
	const args =
		parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};

	const { settings } = ctx.plugin;
	if (settings.disabledTools.includes(call.function.name)) {
		return `Error: the "${call.function.name}" tool is disabled.`;
	}
	if (tool.enabled && !tool.enabled(settings)) {
		return `Error: the "${call.function.name}" tool is currently unavailable.`;
	}

	// Plan-based path: compute before/after, confirm with a diff, then apply.
	if (tool.plan) {
		let plan: EditPlan | string;
		try {
			plan = await tool.plan(ctx, args);
		} catch (e) {
			return `Error: ${(e as Error).message}`;
		}
		if (typeof plan === 'string') return plan;

		if (tool.write && settings.requireWriteConfirmation) {
			const diff = lineDiff(plan.before, plan.after);
			const approved = await opts.confirm({
				title: 'Apply this edit?',
				label: plan.label,
				diff,
			});
			if (!approved) return 'The user declined this edit.';
		}
		try {
			return await plan.apply();
		} catch (e) {
			return `Error: ${(e as Error).message}`;
		}
	}

	if (!tool.run) {
		return `Error: the "${call.function.name}" tool has no implementation.`;
	}
	if (tool.write && settings.requireWriteConfirmation) {
		const detail = tool.describe
			? tool.describe(args)
			: `${call.function.name}(${call.function.arguments})`;
		const approved = await opts.confirm({ title: 'Allow this edit?', detail });
		if (!approved) return 'The user declined this edit.';
	}

	try {
		return await tool.run(ctx, args);
	} catch (e) {
		return `Error: ${(e as Error).message}`;
	}
}
