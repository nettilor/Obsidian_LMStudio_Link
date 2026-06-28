import { App, getAllTags, MarkdownView, TFile } from 'obsidian';
import type LMStudioNotesPlugin from './main';
import { describeError, WireMessage } from './lmstudio';
import { getActiveNote } from './note-context';
import { confirmEdit } from './confirm-modal';
import { executeTool, ToolContext, toolDefsFor } from './tools';
import { hasToolCallMarkers, recoverToolCalls } from './tool-call-recovery';

const TOOL_PARSE_HELP =
	'The model emitted a tool call the local server could not parse (common with ' +
	'gpt-oss / harmony-format models) and it could not be recovered. Try enabling ' +
	'fewer tools (the wrench menu), updating LM Studio, or using a model with native ' +
	'tool-call support.';

/** Safety cap on how many tool round-trips a single user turn may trigger. */
const MAX_TOOL_ITERATIONS = 6;
/** How much active-note text to inject as context, when that option is on. */
const CONTEXT_MAX_CHARS = 16_000;
/** Total budget across all open notes when "All open notes" context is on. */
const OPEN_NOTES_MAX_CHARS = 24_000;
/** Budgets for "Current note + links" mode. */
const LINKED_CONTEXT_MAX_CHARS = 24_000;
const LINKED_ACTIVE_MAX_CHARS = 12_000;
const LINKED_PER_NOTE_MAX_CHARS = 5_000;
/** How long to reuse the vault-wide backlink/tag indexes (ms) before rebuilding. */
const GRAPH_CACHE_TTL = 10_000;
/** Relevance bonus for a directly-linked note, in "shared-tag IDF" units. */
const LINK_WEIGHT = 2;
/** Soft budget for retained conversation history, to avoid context blowups. */
const MAX_HISTORY_CHARS = 16_000;

export type DisplayRole = 'user' | 'assistant' | 'tool' | 'error' | 'context';

export interface DisplayItem {
	role: DisplayRole;
	text: string;
	/** Set on user messages so the view can offer "edit & re-run" for that turn. */
	turnIndex?: number;
	/** Set on tool items whose result was an error, for styling within the fold. */
	isError?: boolean;
	/** For 'context' items: the note paths/labels injected as context this turn. */
	sources?: string[];
}

/** A note-context system message plus the list of notes it injected. */
interface NoteContext {
	message: WireMessage;
	sources: string[];
}

/**
 * One exchange: the user's message plus all wire messages and display items it
 * produced. Storing the conversation as a list of turns makes "edit message N
 * and re-run" a simple truncate-and-resend, and keeps the wire history aligned
 * with what's shown.
 */
interface Turn {
	userText: string;
	wire: WireMessage[];
	display: DisplayItem[];
}

export class ChatSession {
	busy = false;
	private turns: Turn[] = [];
	private backlinkCache: { map: Map<string, string[]>; at: number } | null = null;
	private tagCache: { map: Map<string, string[]>; at: number } | null = null;

	constructor(
		private readonly plugin: LMStudioNotesPlugin,
		private readonly onUpdate: () => void,
	) {}

	/** Flattened view of every turn's display items, tagging user-message turns. */
	get display(): DisplayItem[] {
		const out: DisplayItem[] = [];
		this.turns.forEach((turn, turnIndex) => {
			for (const item of turn.display) {
				out.push(item.role === 'user' ? { ...item, turnIndex } : item);
			}
		});
		return out;
	}

	reset(): void {
		this.turns = [];
		this.onUpdate();
	}

	/** Replace turn `turnIndex` with new text and regenerate from there. */
	async editAndRerun(turnIndex: number, newText: string): Promise<void> {
		if (this.busy) return;
		if (turnIndex < 0 || turnIndex >= this.turns.length) return;
		if (!newText.trim()) return;
		this.turns.length = turnIndex; // drop this turn and everything after it
		await this.send(newText);
	}

	async send(text: string): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed || this.busy) return;

		const { settings, client, app } = this.plugin;
		if (!settings.model) {
			this.turns.push({
				userText: trimmed,
				wire: [{ role: 'user', content: trimmed }],
				display: [
					{ role: 'user', text: trimmed },
					{ role: 'error', text: 'No model selected. Choose one in the plugin settings.' },
				],
			});
			this.onUpdate();
			return;
		}

		this.busy = true;
		const turn: Turn = {
			userText: trimmed,
			wire: [{ role: 'user', content: trimmed }],
			display: [{ role: 'user', text: trimmed }],
		};
		this.turns.push(turn);
		this.onUpdate();

		try {
			// Context (vault facts, date, note content) — computed once, prepended fresh.
			const systemExtras: WireMessage[] = [];
			const guide = this.vaultGuideMessage();
			if (guide) systemExtras.push(guide);
			const dateMsg = this.dateContextMessage();
			if (dateMsg) systemExtras.push(dateMsg);
			const noteCtx = await this.notesContext();
			const context = noteCtx?.message ?? null;
			if (noteCtx && noteCtx.sources.length > 0) {
				turn.display.push({ role: 'context', text: '', sources: noteCtx.sources });
				this.onUpdate();
			}
			const tools = toolDefsFor(settings);
			const ctx: ToolContext = { app, plugin: this.plugin };

			const buildOutgoing = (): WireMessage[] => {
				const msgs: WireMessage[] = [
					{ role: 'system', content: settings.chatSystemPrompt },
					...systemExtras,
				];
				if (context) msgs.push(context);
				msgs.push(...this.historyForSend());
				return msgs;
			};

			let answered = false;
			for (let i = 0; i < MAX_TOOL_ITERATIONS && !answered; i++) {
				const { message } = await client.complete(buildOutgoing(), {
					model: settings.model,
					temperature: settings.temperature,
					tools,
				});
				let calls = message.tool_calls ?? [];
				let content = message.content;
				let brokenToolCall = false;

				// Recover tool calls the server leaked into text (gpt-oss/harmony).
				if (calls.length === 0 && content && hasToolCallMarkers(content)) {
					const recovered = recoverToolCalls(content);
					if (recovered.length > 0) {
						calls = recovered;
						content = null; // the text WAS the tool call; don't show it
					} else {
						brokenToolCall = true;
					}
				}

				// Keep stored assistant messages wire-valid for replay: only include
				// tool_calls when present, and never store null content otherwise.
				turn.wire.push(
					calls.length
						? { role: 'assistant', content, tool_calls: calls }
						: { role: 'assistant', content: brokenToolCall ? '' : content ?? '' },
				);

				if (calls.length === 0) {
					if (brokenToolCall) {
						turn.display.push({ role: 'error', text: TOOL_PARSE_HELP });
					} else {
						const final = (content ?? '').trim();
						turn.display.push({ role: 'assistant', text: final || '(no response)' });
					}
					this.onUpdate();
					answered = true;
					break;
				}

				if (content && content.trim()) {
					turn.display.push({ role: 'assistant', text: content });
					this.onUpdate();
				}

				for (const call of calls) {
					turn.display.push({ role: 'tool', text: `Running ${call.function.name}…` });
					this.onUpdate();

					const result = await executeTool(ctx, call, {
						confirm: (req) => confirmEdit(app, req),
					});

					turn.wire.push({ role: 'tool', content: result, tool_call_id: call.id });
					turn.display[turn.display.length - 1] = toolDisplay(
						call.function.name,
						result,
					);
					this.onUpdate();
				}
			}

			if (!answered) {
				// Hit the tool cap. Force one final text answer (no tools).
				const { message } = await client.complete(buildOutgoing(), {
					model: settings.model,
					temperature: settings.temperature,
				});
				turn.wire.push({ role: 'assistant', content: message.content ?? '' });
				const final = (message.content ?? '').trim();
				turn.display.push({
					role: 'assistant',
					text: final || 'Stopped after several tool calls — try splitting the task up.',
				});
			}
		} catch (e) {
			// Keep only the self-contained user message: drops any partial
			// assistant/tool wire (no dangling tool_calls) while still leaving the
			// prompt as context for later turns.
			turn.wire = [{ role: 'user', content: trimmed }];
			turn.display.push({ role: 'error', text: describeError(e) });
		} finally {
			this.busy = false;
			this.onUpdate();
		}
	}

	/**
	 * The most recent turns whose wire messages fit the history budget (always
	 * including at least the latest). Cutting at turn boundaries keeps every
	 * assistant(tool_calls) message paired with its tool results.
	 */
	private historyForSend(): WireMessage[] {
		const included: Turn[] = [];
		let size = 0;
		for (let i = this.turns.length - 1; i >= 0; i--) {
			const turn = this.turns[i]!;
			const turnSize = turn.wire.reduce(
				(n, m) =>
					n +
					(m.content?.length ?? 0) +
					(m.tool_calls ? JSON.stringify(m.tool_calls).length : 0),
				0,
			);
			if (included.length > 0 && size + turnSize > MAX_HISTORY_CHARS) break;
			included.unshift(turn);
			size += turnSize;
		}
		return included.flatMap((t) => t.wire);
	}

	/** Persistent, user-authored facts about the vault. */
	private vaultGuideMessage(): WireMessage | null {
		const guide = this.plugin.settings.vaultGuide.trim();
		if (!guide) return null;
		return { role: 'system', content: `Facts about this vault (always apply):\n${guide}` };
	}

	/** Today's date and the current/adjacent ISO weeks, so temporal refs resolve. */
	private dateContextMessage(): WireMessage | null {
		if (!this.plugin.settings.includeDateContext) return null;
		const now = new Date();
		const weekday = now.toLocaleDateString(undefined, { weekday: 'long' });
		return {
			role: 'system',
			content:
				`Today's date is ${formatDate(now)} (${weekday}). ` +
				`The current ISO week is ${isoWeekString(now)} ` +
				`(last week ${isoWeekString(addDays(now, -7))}, next week ${isoWeekString(addDays(now, 7))}). ` +
				'Use these when the user refers to today, this week, last week, etc.',
		};
	}

	/** A fresh note context (message + injected source list), regenerated each send. */
	private async notesContext(): Promise<NoteContext | null> {
		const mode = this.plugin.settings.noteContext;
		if (mode === 'none') return null;
		if (mode === 'open') return this.openNotesContext();
		if (mode === 'linked') return this.linkedNotesContext();
		return this.activeNoteContext();
	}

	/** Cached reverse-link index (target path -> source paths). */
	private getBacklinkIndex(
		resolved: Record<string, Record<string, number>>,
	): Map<string, string[]> {
		if (this.backlinkCache && Date.now() - this.backlinkCache.at < GRAPH_CACHE_TTL) {
			return this.backlinkCache.map;
		}
		const map = new Map<string, string[]>();
		for (const [src, targets] of Object.entries(resolved)) {
			for (const tgt of Object.keys(targets)) {
				const arr = map.get(tgt);
				if (arr) arr.push(src);
				else map.set(tgt, [src]);
			}
		}
		this.backlinkCache = { map, at: Date.now() };
		return map;
	}

	/** Cached inverted tag index (tag -> markdown file paths). */
	private getTagIndex(): Map<string, string[]> {
		if (this.tagCache && Date.now() - this.tagCache.at < GRAPH_CACHE_TTL) {
			return this.tagCache.map;
		}
		const { app } = this.plugin;
		const map = new Map<string, string[]>();
		for (const f of app.vault.getMarkdownFiles()) {
			for (const t of new Set(fileTags(app, f))) {
				const arr = map.get(t);
				if (arr) arr.push(f.path);
				else map.set(t, [f.path]);
			}
		}
		this.tagCache = { map, at: Date.now() };
		return map;
	}

	/**
	 * Context covering the active note plus its linked notes (forward/backward)
	 * and notes sharing tags with it — a lightweight RAG over the user's own
	 * relevance signals (links + tags), bounded by the configured caps + budget.
	 */
	private async linkedNotesContext(): Promise<NoteContext | null> {
		const { app, settings } = this.plugin;
		const file = app.workspace.getActiveFile();
		if (!file) return null;

		const active = await getActiveNote(app);
		const activeContent = active ? active.content : await app.vault.cachedRead(file);

		// Cached backlink index (target -> sources) so multi-hop expansion doesn't
		// rescan the whole graph per node or per send.
		const resolved = app.metadataCache.resolvedLinks;
		const backlinks = this.getBacklinkIndex(resolved);
		// resolvedLinks includes attachments (images/PDFs); only follow markdown.
		const isMarkdown = (p: string): boolean => {
			const f = app.vault.getAbstractFileByPath(p);
			return f instanceof TFile && f.extension === 'md';
		};
		const neighbors = (path: string): string[] =>
			[...Object.keys(resolved[path] ?? {}), ...(backlinks.get(path) ?? [])].filter(
				isMarkdown,
			);

		const fileOutgoing = new Set(Object.keys(resolved[file.path] ?? {}));

		// Walk the link graph (1 or 2 hops): path -> hop number.
		const linkedHop = new Map<string, number>();
		const visited = new Set<string>([file.path]);
		let frontier = [file.path];
		for (let hop = 1; hop <= (settings.linkedTwoHop ? 2 : 1); hop++) {
			const next: string[] = [];
			for (const node of frontier) {
				for (const p of neighbors(node)) {
					if (visited.has(p)) continue;
					visited.add(p);
					linkedHop.set(p, hop);
					next.push(p);
				}
			}
			frontier = next;
		}

		// Shared tags per candidate, each weighted by rarity (IDF) so a rare tag
		// like #PME-CCC matters far more than a ubiquitous one like #meeting.
		const currentTags = new Set(fileTags(app, file));
		const tagIndex = this.getTagIndex();
		const totalNotes = Math.max(1, app.vault.getMarkdownFiles().length);
		const idf = (tag: string): number =>
			Math.log((totalNotes + 1) / ((tagIndex.get(tag)?.length ?? 0) + 1)) + 1;
		const sharedTags = new Map<string, string[]>();
		for (const t of currentTags) {
			for (const p of tagIndex.get(t) ?? []) {
				if (p === file.path) continue;
				const arr = sharedTags.get(p);
				if (arr) arr.push(t);
				else sharedTags.set(p, [t]);
			}
		}

		// Score every candidate (rare shared tags dominate; links add a bonus),
		// then keep the most relevant up to the cap.
		const candidates = new Set<string>([...linkedHop.keys(), ...sharedTags.keys()]);
		const scored: Array<{ path: string; score: number; relation: string }> = [];
		for (const p of candidates) {
			const tags = (sharedTags.get(p) ?? []).sort((a, b) => idf(b) - idf(a));
			const hop = linkedHop.get(p);
			const score =
				tags.reduce((s, t) => s + idf(t), 0) +
				(hop === 1 ? LINK_WEIGHT : hop === 2 ? LINK_WEIGHT / 2 : 0);
			if (score <= 0) continue;
			const linkRel =
				hop === 1
					? fileOutgoing.has(p)
						? 'outgoing link'
						: 'backlink'
					: hop === 2
						? '2-hop link'
						: null;
			const tagRel = tags.length ? `shared tags: ${tags.slice(0, 5).join(', ')}` : null;
			scored.push({
				path: p,
				score,
				relation: [linkRel, tagRel].filter((x): x is string => x !== null).join('; '),
			});
		}
		scored.sort((a, b) => b.score - a.score);
		const related = scored.slice(0, settings.linkedMaxNotes);

		// Assemble within the total budget, recording what was actually injected.
		const blocks: string[] = [];
		const sources: string[] = [`${file.path} (active note)`];
		const omitted: string[] = [];
		const activeBody = clampText(activeContent, LINKED_ACTIVE_MAX_CHARS);
		blocks.push(`<active_note path="${file.path}">\n${activeBody}\n</active_note>`);
		let used = activeBody.length;

		for (const r of related) {
			const remaining = LINKED_CONTEXT_MAX_CHARS - used;
			if (remaining <= 0) {
				omitted.push(r.path);
				continue;
			}
			const af = app.vault.getAbstractFileByPath(r.path);
			if (!(af instanceof TFile)) continue;
			const body = clampText(
				await app.vault.cachedRead(af),
				Math.min(remaining, LINKED_PER_NOTE_MAX_CHARS),
			);
			used += body.length;
			blocks.push(`<related_note path="${r.path}" relation="${r.relation}">\n${body}\n</related_note>`);
			sources.push(`${r.path} — ${r.relation}`);
		}

		const sel = active?.selection
			? `\nThe user has selected:\n"""\n${active.selection}\n"""`
			: '';
		const omit = omitted.length
			? `\n\n[${omitted.length} more related note(s) omitted to fit the budget: ${omitted.join(', ')}]`
			: '';
		const header =
			`The user's active note is "${file.path}". Below are that note plus related ` +
			`notes (its links and notes sharing its tags) for context. When the user says ` +
			`"this note" / "the current note", they mean the active one.${sel}`;

		return {
			message: { role: 'system', content: `${header}\n\n${blocks.join('\n\n')}${omit}` },
			sources,
		};
	}

	private async activeNoteContext(): Promise<NoteContext | null> {
		const note = await getActiveNote(this.plugin.app);
		if (!note) return null;
		const body = clampText(note.content, CONTEXT_MAX_CHARS);
		const selection = note.selection
			? `\nThe user has selected:\n"""\n${note.selection}\n"""`
			: '';
		return {
			message: {
				role: 'system',
				content:
					`The user's active note is "${note.file.path}". When they say "this note" / "the current note", they mean this one.${selection}\n\n` +
					`<active_note path="${note.file.path}">\n${body}\n</active_note>`,
			},
			sources: [note.file.path],
		};
	}

	/** Context covering every markdown note open in a tab, active note first. */
	private async openNotesContext(): Promise<NoteContext | null> {
		const { workspace, vault } = this.plugin.app;
		const activePath = workspace.getActiveFile()?.path ?? null;
		const leaves = workspace.getLeavesOfType('markdown');

		const entries: Array<{ path: string; content: string; active: boolean }> = [];
		const seen = new Set<string>();
		let activeSelection = '';

		// Pass 1: loaded tabs win — use the live editor buffer.
		for (const leaf of leaves) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView) || !view.file) continue;
			const path = view.file.path;
			if (path === activePath) activeSelection = view.editor.getSelection();
			if (seen.has(path)) continue;
			seen.add(path);
			entries.push({ path, content: view.editor.getValue(), active: path === activePath });
		}

		// Pass 2: deferred/background tabs (Obsidian 1.7.2+) — read from disk.
		for (const leaf of leaves) {
			if (leaf.view instanceof MarkdownView && leaf.view.file) continue;
			const fp: unknown = leaf.getViewState().state?.file;
			const file = typeof fp === 'string' ? vault.getAbstractFileByPath(fp) : null;
			if (!(file instanceof TFile) || seen.has(file.path)) continue;
			seen.add(file.path);
			entries.push({
				path: file.path,
				content: await vault.cachedRead(file),
				active: file.path === activePath,
			});
		}
		if (entries.length === 0) return null;

		entries.sort((a, b) => Number(b.active) - Number(a.active));

		let used = 0;
		const blocks: string[] = [];
		const sources: string[] = [];
		const omitted: string[] = [];
		for (const e of entries) {
			const remaining = OPEN_NOTES_MAX_CHARS - used;
			if (remaining <= 0) {
				omitted.push(e.path);
				continue;
			}
			const body = clampText(e.content, remaining);
			used += body.length;
			blocks.push(
				`<open_note path="${e.path}"${e.active ? ' active="true"' : ''}>\n${body}\n</open_note>`,
			);
			sources.push(e.active ? `${e.path} (active)` : e.path);
		}

		const activeEntry = entries.find((e) => e.active) ?? null;
		const sel =
			activeEntry && activeSelection
				? `\nThe user has selected (in the active note):\n"""\n${activeSelection}\n"""`
				: '';
		const omit = omitted.length
			? `\n\n[${omitted.length} more open note(s) omitted to fit the context budget: ${omitted.join(', ')}]`
			: '';
		const header = activeEntry
			? `The user has ${entries.length} note(s) open; the active note is "${activeEntry.path}". When they say "this note" / "the current note", they mean it.`
			: `The user has ${entries.length} note(s) open.`;

		return {
			message: { role: 'system', content: `${header}${sel}\n\n${blocks.join('\n\n')}${omit}` },
			sources,
		};
	}
}

function toolDisplay(name: string, result: string): DisplayItem {
	// Always role 'tool' (so the view can group/collapse tool activity); the
	// isError flag drives red styling within the fold. Top-level errors keep
	// role 'error' and stay visible.
	return {
		role: 'tool',
		text: `${name}: ${firstLine(result)}`,
		isError: isToolError(result),
	};
}

function isToolError(result: string): boolean {
	return /^(Error|Note not found|A file already exists|The user declined)/i.test(
		result.trim(),
	);
}

function firstLine(s: string): string {
	const line = s.split('\n')[0] ?? '';
	return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

function clampText(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}

/** All tags on a file (inline + frontmatter), each with a leading '#'. */
function fileTags(app: App, file: TFile): string[] {
	const cache = app.metadataCache.getFileCache(file);
	return cache ? (getAllTags(cache) ?? []) : [];
}


function pad2(n: number): string {
	return String(n).padStart(2, '0');
}

function formatDate(d: Date): string {
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function addDays(d: Date, days: number): Date {
	const r = new Date(d.getTime());
	r.setDate(r.getDate() + days);
	return r;
}

/** ISO-8601 week as "YYYY-Www" (e.g. 2026-W26), using the ISO week-year. */
function isoWeekString(date: Date): string {
	const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
	const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
	d.setUTCDate(d.getUTCDate() - dayNum + 3); // Thursday of this week
	const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
	const ftDayNum = (firstThursday.getUTCDay() + 6) % 7;
	firstThursday.setUTCDate(firstThursday.getUTCDate() - ftDayNum + 3);
	const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
	return `${d.getUTCFullYear()}-W${pad2(week)}`;
}
