import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf, setIcon } from 'obsidian';
import type LMStudioNotesPlugin from './main';
import { ChatSession, DisplayItem } from './chat-session';
import { NoteContextMode } from './settings';
import { openToolsMenu } from './tool-menu';
import { describeError } from './lmstudio';

export const VIEW_TYPE_CHAT = 'lmstudio-notes-chat';

/** Display metadata for each note-context mode, in cycle order. */
const CONTEXT_MODES: Array<{ mode: NoteContextMode; icon: string; label: string }> = [
	{ mode: 'none', icon: 'circle-slash', label: 'No context' },
	{ mode: 'active', icon: 'file', label: 'Active note' },
	{ mode: 'open', icon: 'files', label: 'All open notes' },
];

/** The in-Obsidian chat pane that drives the local model and its tools. */
export class ChatView extends ItemView {
	private session: ChatSession;
	private messagesEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private newBtn!: HTMLButtonElement;
	private contextBtn!: HTMLButtonElement;
	/** Turn index whose user message is currently being edited, if any. */
	private editingTurn: number | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: LMStudioNotesPlugin,
	) {
		super(leaf);
		this.session = new ChatSession(plugin, () => this.render());
	}

	getViewType(): string {
		return VIEW_TYPE_CHAT;
	}

	getDisplayText(): string {
		return 'LM Studio chat';
	}

	getIcon(): string {
		return 'messages-square';
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('lmstudio-notes-chat');
		this.applyFontSize();

		const header = root.createDiv({ cls: 'lmstudio-notes-chat-header' });
		header.createSpan({ text: 'LM Studio chat', cls: 'lmstudio-notes-chat-title' });

		const controls = header.createDiv({ cls: 'lmstudio-notes-chat-controls' });

		// Tools dropdown: enable/disable which tools the model may call.
		const toolsBtn = controls.createEl('button', {
			cls: 'lmstudio-notes-chat-tools clickable-icon',
			attr: { 'aria-label': 'Tools the model can use' },
		});
		setIcon(toolsBtn, 'wrench');
		this.registerDomEvent(toolsBtn, 'click', (evt: MouseEvent) =>
			openToolsMenu(this.plugin, evt),
		);

		// Note-context toggle: cycles None → Active note → All open notes, kept
		// in sync with the same setting shown in the settings tab.
		this.contextBtn = controls.createEl('button', {
			cls: 'lmstudio-notes-context-toggle',
		});
		this.registerDomEvent(this.contextBtn, 'click', () => void this.cycleContext());
		this.updateContextButton();

		this.newBtn = controls.createEl('button', {
			cls: 'lmstudio-notes-chat-new clickable-icon',
			attr: { 'aria-label': 'New chat' },
		});
		setIcon(this.newBtn, 'plus');
		this.registerDomEvent(this.newBtn, 'click', () => {
			if (!this.session.busy) this.session.reset();
		});

		this.messagesEl = root.createDiv({ cls: 'lmstudio-notes-chat-messages' });

		const inputRow = root.createDiv({ cls: 'lmstudio-notes-chat-input' });
		this.inputEl = inputRow.createEl('textarea', {
			attr: { rows: '2', placeholder: 'Ask about or edit your notes…' },
		});
		this.sendBtn = inputRow.createEl('button', { text: 'Send', cls: 'mod-cta' });

		this.registerDomEvent(this.inputEl, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				void this.submit();
			}
		});
		this.registerDomEvent(this.sendBtn, 'click', () => void this.submit());

		this.render();
	}

	/** Re-sync header controls (e.g. after the note-context setting changes elsewhere). */
	refreshControls(): void {
		this.updateContextButton();
	}

	/** Apply the configured chat font size as a CSS variable on this pane. */
	applyFontSize(): void {
		this.contentEl.setCssProps({
			'--lmstudio-chat-font-size': `${this.plugin.settings.chatFontSize}px`,
		});
	}

	private async submit(): Promise<void> {
		if (this.session.busy) return;
		const text = this.inputEl.value;
		if (!text.trim()) return;
		this.inputEl.value = '';
		await this.session.send(text);
	}

	/** Advance the note-context mode and persist it. */
	private async cycleContext(): Promise<void> {
		const idx = CONTEXT_MODES.findIndex(
			(m) => m.mode === this.plugin.settings.noteContext,
		);
		const next = CONTEXT_MODES[(idx + 1) % CONTEXT_MODES.length]!;
		this.plugin.settings.noteContext = next.mode;
		await this.plugin.saveSettings();
		this.updateContextButton();
	}

	private updateContextButton(): void {
		const current =
			CONTEXT_MODES.find((m) => m.mode === this.plugin.settings.noteContext) ??
			CONTEXT_MODES[1]!;
		this.contextBtn.empty();
		setIcon(this.contextBtn.createSpan({ cls: 'lmstudio-notes-context-icon' }), current.icon);
		this.contextBtn.createSpan({ text: current.label });
		const tip = `Note context: ${current.label} (click to change)`;
		this.contextBtn.setAttribute('aria-label', tip);
		this.contextBtn.setAttribute('title', tip);
	}

	private render(): void {
		if (!this.messagesEl) return;
		this.messagesEl.empty();
		for (const item of this.session.display) this.renderItem(item);
		if (this.session.busy) {
			this.messagesEl.createDiv({
				cls: 'lmstudio-notes-msg lmstudio-notes-thinking',
				text: 'Thinking…',
			});
		}
		this.inputEl.disabled = this.session.busy;
		this.sendBtn.disabled = this.session.busy;
		this.newBtn.disabled = this.session.busy;
		// Keep the latest message in view, but not while editing an earlier one.
		if (this.editingTurn === null) {
			this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
		}
	}

	private renderItem(item: DisplayItem): void {
		const el = this.messagesEl.createDiv({
			cls: `lmstudio-notes-msg lmstudio-notes-${item.role}`,
		});

		if (item.role === 'user' && item.turnIndex === this.editingTurn) {
			this.renderEditor(el, item.turnIndex, item.text);
			return;
		}

		const content = el.createDiv({ cls: 'lmstudio-notes-msg-content' });
		if (item.role === 'assistant') {
			void MarkdownRenderer.render(this.app, item.text, content, '', this);
		} else {
			content.setText(item.text);
		}

		if (item.role === 'assistant' || item.role === 'user') {
			this.renderActions(el, item);
		}
	}

	private renderActions(el: HTMLElement, item: DisplayItem): void {
		const actions = el.createDiv({ cls: 'lmstudio-notes-msg-actions' });

		const copyBtn = actions.createEl('button', {
			cls: 'clickable-icon',
			attr: { 'aria-label': 'Copy' },
		});
		setIcon(copyBtn, 'copy');
		// Plain listeners on per-message elements (recreated every render): they
		// are GC'd with the element on the next messagesEl.empty(), so unlike
		// registerDomEvent they don't accumulate on the view for its lifetime.
		copyBtn.addEventListener('click', () => void this.copyText(item.text));

		if (item.role === 'user' && typeof item.turnIndex === 'number' && !this.session.busy) {
			const turnIndex = item.turnIndex;
			const editBtn = actions.createEl('button', {
				cls: 'clickable-icon',
				attr: { 'aria-label': 'Edit & re-run' },
			});
			setIcon(editBtn, 'pencil');
			editBtn.addEventListener('click', () => {
				this.editingTurn = turnIndex;
				this.render();
			});
		}
	}

	private renderEditor(el: HTMLElement, turnIndex: number, text: string): void {
		el.addClass('lmstudio-notes-msg-editing');
		const textarea = el.createEl('textarea', { cls: 'lmstudio-notes-edit-input' });
		textarea.value = text;
		textarea.rows = Math.min(10, Math.max(2, text.split('\n').length));

		const row = el.createDiv({ cls: 'lmstudio-notes-edit-actions' });
		const save = row.createEl('button', { text: 'Save & run', cls: 'mod-cta' });
		const cancel = row.createEl('button', { text: 'Cancel' });

		const commit = () => {
			const value = textarea.value;
			if (!value.trim()) return; // nothing to run; keep the editor open
			this.editingTurn = null;
			this.render(); // tear down the editor regardless of editAndRerun's path
			void this.session.editAndRerun(turnIndex, value);
		};
		const dismiss = () => {
			this.editingTurn = null;
			this.render();
		};

		save.addEventListener('click', commit);
		cancel.addEventListener('click', dismiss);
		textarea.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				commit();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				dismiss();
			}
		});

		textarea.focus();
		el.scrollIntoView({ block: 'nearest' });
	}

	private async copyText(text: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
			new Notice('Copied to clipboard.');
		} catch (e) {
			new Notice(`Could not copy to clipboard: ${describeError(e)}`);
		}
	}
}
