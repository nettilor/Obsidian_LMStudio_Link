import { App, getAllTags, MarkdownView, TFile } from 'obsidian';
import type LMStudioNotesPlugin from './main';
import { describeError, StreamResult, ToolDef, WireMessage } from './lmstudio';
import { getActiveNote } from './note-context';
import { confirmEdit } from './confirm-modal';
import { executeTool, ToolContext, toolDefsFor } from './tools';
import { hasToolCallMarkers, recoverToolCalls } from './tool-call-recovery';
import { hybridRetrieve, RetrievedNote } from './retrieval';
import { ContextSize, LMStudioNotesSettings } from './settings';

const TOOL_PARSE_HELP =
	'The model emitted a tool call the local server could not parse (common with ' +
	'gpt-oss / harmony-format models) and it could not be recovered. Try enabling ' +
	'fewer tools (the wrench menu), updating LM Studio, or using a model with native ' +
	'tool-call support.';

/** How long to reuse the vault-wide backlink/tag indexes (ms) before rebuilding. */
const GRAPH_CACHE_TTL = 10_000;
/** Relevance bonus for a directly-linked note, in "shared-tag IDF" units. */
const LINK_WEIGHT = 2;

/**
 * Character budgets at the "standard" context size (~8k-token models); the
 * user's context-size setting scales all of them together.
 */
const CONTEXT_SCALE: Record<ContextSize, number> = {
	compact: 0.5,
	standard: 1,
	large: 2,
	max: 4,
};

interface Budgets {
	/** Active-note text injected as context. */
	activeNote: number;
	/** Total across all open notes ("All open notes" mode). */
	openNotes: number;
	/** Totals for "Current note + links" mode. */
	linkedTotal: number;
	linkedActive: number;
	linkedPerNote: number;
	/** Retained conversation history. */
	history: number;
}

function budgetsFor(settings: LMStudioNotesSettings): Budgets {
	const k = CONTEXT_SCALE[settings.contextSize] ?? 1;
	return {
		activeNote: 16_000 * k,
		openNotes: 24_000 * k,
		linkedTotal: 24_000 * k,
		linkedActive: 12_000 * k,
		linkedPerNote: 5_000 * k,
		history: 16_000 * k,
	};
}

export type DisplayRole =
	| 'user'
	| 'assistant'
	| 'reasoning'
	| 'tool'
	| 'error'
	| 'notice'
	| 'context';

export interface DisplayItem {
	role: DisplayRole;
	text: string;
	/** Set on user messages so the view can offer "edit & re-run" for that turn. */
	turnIndex?: number;
	/** Set on tool items whose result was an error, for styling within the fold. */
	isError?: boolean;
	/** For 'context' items: the note paths/labels injected as context this turn. */
	sources?: string[];
	/** True while this item is receiving streamed tokens. */
	streaming?: boolean;
	/** Generation stats to show after the message, e.g. "42 tok/s". */
	stats?: string;
}

/** Callbacks the chat view wires up to react to session changes. */
export interface ChatSessionEvents {
	/** Structural change (item added/removed/finalized) — re-render everything. */
	onUpdate(): void;
	/** Streamed text changed on one item — update just that element. */
	onToken(item: DisplayItem): void;
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
	private abortCtl: AbortController | null = null;
	private backlinkCache: { map: Map<string, string[]>; at: number } | null = null;
	private tagCache: { map: Map<string, string[]>; at: number } | null = null;

	constructor(
		private readonly plugin: LMStudioNotesPlugin,
		private readonly events: ChatSessionEvents,
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
		this.events.onUpdate();
	}

	/** Abort the in-flight generation; the partial answer is kept. */
	stop(): void {
		this.abortCtl?.abort();
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

		const { settings, app } = this.plugin;
		if (!settings.model) {
			this.turns.push({
				userText: trimmed,
				wire: [{ role: 'user', content: trimmed }],
				display: [
					{ role: 'user', text: trimmed },
					{ role: 'error', text: 'No model selected. Choose one in the plugin settings.' },
				],
			});
			this.events.onUpdate();
			return;
		}

		this.busy = true;
		this.plugin.activeGenerations++;
		this.abortCtl = new AbortController();
		const signal = this.abortCtl.signal;
		const turn: Turn = {
			userText: trimmed,
			wire: [{ role: 'user', content: trimmed }],
			display: [{ role: 'user', text: trimmed }],
		};
		this.turns.push(turn);
		this.events.onUpdate();

		try {
			// Context (vault facts, date, note content) — computed once, prepended fresh.
			const systemExtras: WireMessage[] = [];
			const guide = this.vaultGuideMessage();
			if (guide) systemExtras.push(guide);
			const dateMsg = this.dateContextMessage();
			if (dateMsg) systemExtras.push(dateMsg);
			const noteCtx = await this.notesContext(trimmed);
			const context = noteCtx?.message ?? null;
			if (noteCtx && noteCtx.sources.length > 0) {
				turn.display.push({ role: 'context', text: '', sources: noteCtx.sources });
				this.events.onUpdate();
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

			const maxIterations = Math.max(1, settings.maxToolIterations);
			let answered = false;
			for (let i = 0; i < maxIterations && !answered && !signal.aborted; i++) {
				const res = await this.streamCompletion(turn, buildOutgoing(), tools, signal);
				let calls = res.message.tool_calls ?? [];
				let content = res.message.content;
				let brokenToolCall = false;

				if (res.aborted) {
					// Keep the partial text; never execute tool calls from a cut stream.
					turn.wire.push({ role: 'assistant', content: content ?? '' });
					this.markStopped(turn, res);
					answered = true;
					break;
				}

				// Recover tool calls the server leaked into text (gpt-oss/harmony).
				if (calls.length === 0 && content && hasToolCallMarkers(content)) {
					const recovered = recoverToolCalls(content);
					if (recovered.length > 0) {
						calls = recovered;
						content = null; // the text WAS the tool call; don't show it
						if (res.textItem) removeItem(turn.display, res.textItem);
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
						if (res.textItem) removeItem(turn.display, res.textItem);
						turn.display.push({ role: 'error', text: TOOL_PARSE_HELP });
					} else if (!res.textItem) {
						turn.display.push({ role: 'assistant', text: '(no response)' });
					} else if (!res.textItem.text.trim()) {
						res.textItem.text = '(no response)';
					}
					this.events.onUpdate();
					answered = true;
					break;
				}

				for (const call of calls) {
					// A stop mid-tool-run still needs a result per call to keep the
					// wire history valid for later turns.
					if (signal.aborted) {
						turn.wire.push({
							role: 'tool',
							content: 'Cancelled by the user.',
							tool_call_id: call.id,
						});
						continue;
					}
					turn.display.push({ role: 'tool', text: `Running ${call.function.name}…` });
					this.events.onUpdate();

					const result = await executeTool(ctx, call, {
						confirm: (req) => confirmEdit(app, req),
					});

					turn.wire.push({ role: 'tool', content: result, tool_call_id: call.id });
					turn.display[turn.display.length - 1] = toolDisplay(
						call.function.name,
						result,
					);
					this.events.onUpdate();
				}

				if (signal.aborted) {
					this.markStopped(turn, null);
					answered = true;
					break;
				}
			}

			if (!answered && !signal.aborted) {
				// Hit the tool cap. Force one final text answer (no tools).
				const res = await this.streamCompletion(turn, buildOutgoing(), undefined, signal);
				turn.wire.push({ role: 'assistant', content: res.message.content ?? '' });
				if (res.aborted) {
					this.markStopped(turn, res);
				} else if (!res.textItem) {
					turn.display.push({
						role: 'assistant',
						text: 'Stopped after several tool calls — try splitting the task up.',
					});
				}
			}

		} catch (e) {
			// Keep only the self-contained user message: drops any partial
			// assistant/tool wire (no dangling tool_calls) while still leaving the
			// prompt as context for later turns.
			turn.wire = [{ role: 'user', content: trimmed }];
			turn.display.push({ role: 'error', text: describeError(e) });
		} finally {
			this.busy = false;
			this.plugin.activeGenerations--;
			this.abortCtl = null;
			this.events.onUpdate();
			// The server is idle again — a good moment to catch the semantic index
			// up on files created/edited during this turn (or while LM Studio was
			// off). Runs after the counter drops so it isn't deferred by it.
			void this.plugin.semanticIndex.reconcile();
		}
	}

	/**
	 * Run one streamed completion, materializing reasoning/answer display items
	 * as their first tokens arrive and finalizing them when the stream ends.
	 */
	private async streamCompletion(
		turn: Turn,
		outgoing: WireMessage[],
		tools: ToolDef[] | undefined,
		signal: AbortSignal,
	): Promise<StreamResult & { textItem: DisplayItem | null; reasoningItem: DisplayItem | null }> {
		const { settings, client } = this.plugin;
		let reasoningItem: DisplayItem | null = null;
		let textItem: DisplayItem | null = null;

		let result: StreamResult;
		try {
			result = await client.completeStream(
				outgoing,
				{
					model: settings.model,
					temperature: settings.temperature,
					maxTokens: settings.maxOutputTokens > 0 ? settings.maxOutputTokens : undefined,
					tools,
				},
				{
					onReasoning: (_delta, full) => {
						if (!reasoningItem) {
							reasoningItem = { role: 'reasoning', text: '', streaming: true };
							turn.display.push(reasoningItem);
							this.events.onUpdate();
						}
						reasoningItem.text = full;
						this.events.onToken(reasoningItem);
					},
					onText: (_delta, full) => {
						if (!textItem) {
							textItem = { role: 'assistant', text: '', streaming: true };
							turn.display.push(textItem);
							this.events.onUpdate();
						}
						textItem.text = full;
						this.events.onToken(textItem);
					},
				},
				signal,
			);
		} finally {
			// Finalize even when the stream fails, so no item is left in a
			// permanently-streaming (plain-text, no actions) state.
			if (reasoningItem) (reasoningItem as DisplayItem).streaming = false;
			if (textItem) (textItem as DisplayItem).streaming = false;
			this.events.onUpdate();
		}

		if (textItem && result.stats.tokens > 0 && result.stats.seconds >= 1) {
			(textItem as DisplayItem).stats =
				`${(result.stats.tokens / result.stats.seconds).toFixed(1)} tok/s`;
		}
		return { ...result, textItem, reasoningItem };
	}

	/** Surface a user-initiated stop in the transcript. */
	private markStopped(
		turn: Turn,
		res: { textItem: DisplayItem | null } | null,
	): void {
		if (res?.textItem && !res.textItem.text.trim()) {
			removeItem(turn.display, res.textItem);
		}
		turn.display.push({ role: 'notice', text: 'Stopped.' });
		this.events.onUpdate();
	}

	/**
	 * The most recent turns whose wire messages fit the history budget (always
	 * including at least the latest). Cutting at turn boundaries keeps every
	 * assistant(tool_calls) message paired with its tool results.
	 */
	private historyForSend(): WireMessage[] {
		const budget = budgetsFor(this.plugin.settings).history;
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
			if (included.length > 0 && size + turnSize > budget) break;
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
	private async notesContext(userText: string): Promise<NoteContext | null> {
		const mode = this.plugin.settings.noteContext;
		if (mode === 'none') return null;
		if (mode === 'open') return this.openNotesContext();
		if (mode === 'linked') return this.linkedNotesContext();
		if (mode === 'relevant') return this.relevantNotesContext(userText);
		return this.activeNoteContext();
	}

	/**
	 * Auto-RAG context: retrieve the vault content most relevant to the user's
	 * message (hybrid keyword + semantic) and inject the best excerpts, plus
	 * the active note. This needs NO tool calls from the model, which makes it
	 * the most reliable mode for small local models.
	 */
	private async relevantNotesContext(userText: string): Promise<NoteContext | null> {
		const { app, settings } = this.plugin;
		const budgets = budgetsFor(settings);
		const file = app.workspace.getActiveFile();
		const active = file ? await getActiveNote(app) : null;

		const blocks: string[] = [];
		const sources: string[] = [];
		let used = 0;

		if (file) {
			const activeContent = active ? active.content : await app.vault.cachedRead(file);
			const body = clampText(activeContent, budgets.linkedActive);
			blocks.push(`<active_note path="${file.path}">\n${body}\n</active_note>`);
			sources.push(`${file.path} (active note)`);
			used += body.length;
		}

		let retrieved: RetrievedNote[] = [];
		try {
			retrieved = (
				await hybridRetrieve(this.plugin, userText, {
					limit: settings.retrievedMaxNotes,
					excludePaths: file ? [file.path] : [],
				})
			).notes;
		} catch {
			// Retrieval must never block sending a message.
		}

		for (const r of retrieved) {
			const remaining = budgets.linkedTotal - used;
			if (remaining <= 0) break;
			if (!r.excerpt) continue;
			const body = clampText(r.excerpt, Math.min(remaining, budgets.linkedPerNote));
			used += body.length;
			const headingAttr = r.heading ? ` heading="${r.heading}"` : '';
			blocks.push(
				`<relevant_note path="${r.path}" match="${r.via}"${headingAttr}>\n${body}\n</relevant_note>`,
			);
			sources.push(`${r.path} — ${r.via}${r.heading ? ` (${r.heading})` : ''}`);
		}

		if (blocks.length === 0) return null;

		const sel = active?.selection
			? `\nThe user has selected:\n"""\n${active.selection}\n"""`
			: '';
		const activeIntro = file
			? `The user's active note is "${file.path}" (included below). `
			: '';
		const header =
			`${activeIntro}The <relevant_note> blocks are EXCERPTS from vault notes ` +
			`retrieved as relevant to the user's message — they may be partial. Use ` +
			`read_note for a note's full content before editing it.${sel}`;

		return {
			message: { role: 'system', content: `${header}\n\n${blocks.join('\n\n')}` },
			sources,
		};
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
		const budgets = budgetsFor(settings);
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
		const activeBody = clampText(activeContent, budgets.linkedActive);
		blocks.push(`<active_note path="${file.path}">\n${activeBody}\n</active_note>`);
		let used = activeBody.length;

		for (const r of related) {
			const remaining = budgets.linkedTotal - used;
			if (remaining <= 0) {
				omitted.push(r.path);
				continue;
			}
			const af = app.vault.getAbstractFileByPath(r.path);
			if (!(af instanceof TFile)) continue;
			const body = clampText(
				await app.vault.cachedRead(af),
				Math.min(remaining, budgets.linkedPerNote),
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
		const body = clampText(note.content, budgetsFor(this.plugin.settings).activeNote);
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
		const budget = budgetsFor(this.plugin.settings).openNotes;
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
			const remaining = budget - used;
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

function removeItem(list: DisplayItem[], item: DisplayItem): void {
	const idx = list.indexOf(item);
	if (idx !== -1) list.splice(idx, 1);
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
