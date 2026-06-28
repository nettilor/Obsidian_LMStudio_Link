import { Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import {
	DEFAULT_SETTINGS,
	LMStudioNotesSettings,
	LMStudioNotesSettingTab,
} from './settings';
import { LMStudioClient } from './lmstudio';
import { registerCommands } from './commands';
import { ChatView, VIEW_TYPE_CHAT } from './chat-view';
import { SemanticIndex } from './semantic-index';
import { EDITING_TOOL_NAMES } from './tools';

export default class LMStudioNotesPlugin extends Plugin {
	settings!: LMStudioNotesSettings;
	client!: LMStudioClient;
	semanticIndex!: SemanticIndex;
	/** Guards against overlapping generations (commands + ribbon + hotkeys). */
	summarizing = false;

	async onload() {
		await this.loadSettings();

		// The client reads config lazily so settings changes take effect live.
		this.client = new LMStudioClient(() => ({
			baseUrl: this.settings.baseUrl,
			apiKey: this.settings.apiKey,
		}));

		this.semanticIndex = new SemanticIndex(this);
		this.registerSemanticIndexEvents();

		this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf, this));

		registerCommands(this);
		this.addSettingTab(new LMStudioNotesSettingTab(this.app, this));
	}

	/** Keep the semantic index current as notes are edited, added, or removed. */
	private registerSemanticIndexEvents(): void {
		const isMd = (f: unknown): f is TFile => f instanceof TFile && f.extension === 'md';
		this.registerEvent(
			this.app.vault.on('modify', (f) => {
				if (isMd(f)) this.semanticIndex.queueUpdate(f);
			}),
		);
		this.registerEvent(
			this.app.vault.on('create', (f) => {
				if (isMd(f)) this.semanticIndex.queueUpdate(f);
			}),
		);
		this.registerEvent(
			this.app.vault.on('delete', (f) => this.semanticIndex.queueRemove(f.path)),
		);
		this.registerEvent(
			this.app.vault.on('rename', (f, oldPath) => {
				this.semanticIndex.queueRemove(oldPath);
				if (isMd(f)) this.semanticIndex.queueUpdate(f);
			}),
		);
	}

	onunload() {}

	/** Re-apply settings that affect open chat panes (font size, header controls). */
	refreshChatViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)) {
			if (leaf.view instanceof ChatView) {
				leaf.view.applyFontSize();
				leaf.view.refreshControls();
			}
		}
	}

	/** Open (or focus) the chat pane in the right sidebar. */
	async activateChatView(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_CHAT);
		let leaf: WorkspaceLeaf | null = existing[0] ?? null;

		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			if (leaf) await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
		}
		if (leaf) await workspace.revealLeaf(leaf);
	}

	async loadSettings() {
		const loaded = ((await this.loadData()) ?? {}) as Partial<LMStudioNotesSettings> & {
			includeActiveNoteContext?: boolean;
			enableEditingTools?: boolean;
		};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);

		// Migrate the pre-0.3 boolean `includeActiveNoteContext` to `noteContext`.
		if (loaded.noteContext === undefined && loaded.includeActiveNoteContext !== undefined) {
			this.settings.noteContext = loaded.includeActiveNoteContext ? 'active' : 'none';
		}
		delete (this.settings as { includeActiveNoteContext?: boolean }).includeActiveNoteContext;

		// Migrate the pre-0.5 boolean `enableEditingTools` to `disabledTools`.
		if (loaded.disabledTools === undefined && loaded.enableEditingTools === false) {
			this.settings.disabledTools = [...EDITING_TOOL_NAMES];
		}
		delete (this.settings as { enableEditingTools?: boolean }).enableEditingTools;

		// Coerce out-of-range persisted values back to defaults.
		if (!['none', 'active', 'open'].includes(this.settings.noteContext)) {
			this.settings.noteContext = DEFAULT_SETTINGS.noteContext;
		}
		if (!Array.isArray(this.settings.disabledTools)) {
			this.settings.disabledTools = [];
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
