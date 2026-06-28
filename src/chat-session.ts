import { MarkdownView, TFile } from 'obsidian';
import type LMStudioNotesPlugin from './main';
import { describeError, WireMessage } from './lmstudio';
import { getActiveNote } from './note-context';
import { confirmEdit } from './confirm-modal';
import { executeTool, ToolContext, toolDefsFor } from './tools';

/** Safety cap on how many tool round-trips a single user turn may trigger. */
const MAX_TOOL_ITERATIONS = 6;
/** How much active-note text to inject as context, when that option is on. */
const CONTEXT_MAX_CHARS = 16_000;
/** Total budget across all open notes when "All open notes" context is on. */
const OPEN_NOTES_MAX_CHARS = 24_000;
/** Soft budget for retained conversation history, to avoid context blowups. */
const MAX_HISTORY_CHARS = 16_000;

export type DisplayRole = 'user' | 'assistant' | 'tool' | 'error';

export interface DisplayItem {
	role: DisplayRole;
	text: string;
	/** Set on user messages so the view can offer "edit & re-run" for that turn. */
	turnIndex?: number;
	/** Set on tool items whose result was an error, for styling within the fold. */
	isError?: boolean;
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
			// Note context is computed once and prepended fresh each request.
			const context = await this.notesContext();
			const tools = toolDefsFor(settings);
			const ctx: ToolContext = { app, plugin: this.plugin };

			const buildOutgoing = (): WireMessage[] => {
				const msgs: WireMessage[] = [
					{ role: 'system', content: settings.chatSystemPrompt },
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
				const calls = message.tool_calls ?? [];
				// Keep stored assistant messages wire-valid for replay: only include
				// tool_calls when present, and never store null content otherwise.
				turn.wire.push(
					calls.length
						? { role: 'assistant', content: message.content, tool_calls: message.tool_calls }
						: { role: 'assistant', content: message.content ?? '' },
				);

				if (calls.length === 0) {
					const final = (message.content ?? '').trim();
					turn.display.push({ role: 'assistant', text: final || '(no response)' });
					this.onUpdate();
					answered = true;
					break;
				}

				if (message.content && message.content.trim()) {
					turn.display.push({ role: 'assistant', text: message.content });
					this.onUpdate();
				}

				for (const call of calls) {
					turn.display.push({ role: 'tool', text: `Running ${call.function.name}…` });
					this.onUpdate();

					const result = await executeTool(ctx, call, {
						confirm: (title, detail) => confirmEdit(app, title, detail),
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

	/** A fresh system message describing the note context, regenerated each send. */
	private async notesContext(): Promise<WireMessage | null> {
		const mode = this.plugin.settings.noteContext;
		if (mode === 'none') return null;
		return mode === 'open' ? this.openNotesContext() : this.activeNoteContext();
	}

	private async activeNoteContext(): Promise<WireMessage | null> {
		const note = await getActiveNote(this.plugin.app);
		if (!note) return null;
		const body = clampText(note.content, CONTEXT_MAX_CHARS);
		const selection = note.selection
			? `\nThe user has selected:\n"""\n${note.selection}\n"""`
			: '';
		return {
			role: 'system',
			content:
				`The user's active note is "${note.file.path}". When they say "this note" / "the current note", they mean this one.${selection}\n\n` +
				`<active_note path="${note.file.path}">\n${body}\n</active_note>`,
		};
	}

	/** Context covering every markdown note open in a tab, active note first. */
	private async openNotesContext(): Promise<WireMessage | null> {
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

		return { role: 'system', content: `${header}${sel}\n\n${blocks.join('\n\n')}${omit}` };
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
