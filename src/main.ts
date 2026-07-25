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

/** How often to re-check the semantic index against the vault (30 min). */
const RECONCILE_INTERVAL_MS = 30 * 60 * 1000;

export default class LMStudioNotesPlugin extends Plugin {
	settings!: LMStudioNotesSettings;
	client!: LMStudioClient;
	semanticIndex!: SemanticIndex;
	/** Guards against overlapping generations (commands + ribbon + hotkeys). */
	summarizing = false;
	/**
	 * Count of chat/summarize generations currently in flight. Background
	 * embedding work checks this and defers: on LM Studio setups that evict
	 * models to make room (JIT auto-evict), an embedding request landing
	 * mid-generation can unload the chat model and fail the chat with HTTP 400.
	 */
	activeGenerations = 0;

	async onload() {
		await this.loadSettings();

		// The client reads config lazily so settings changes take effect live.
		this.client = new LMStudioClient(() => ({
			baseUrl: this.settings.baseUrl,
			apiKey: this.settings.apiKey,
		}));

		this.semanticIndex = new SemanticIndex(this);
		this.registerSemanticIndexEvents();

		// Catch up on changes made while Obsidian was closed, synced in from
		// another device, or skipped because LM Studio wasn't running at the
		// time: reconcile once the workspace is ready, then periodically. When
		// LM Studio is offline the sweep queues the stale files and retries on
		// a later tick — cheap enough to run unconditionally.
		this.app.workspace.onLayoutReady(() => void this.semanticIndex.reconcile());
		this.registerInterval(
			window.setInterval(
				() => void this.semanticIndex.reconcile(),
				RECONCILE_INTERVAL_MS,
			),
		);

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

		// Migrate the pre-0.10 separate link/tag caps into one relevance cap.
		const legacyLinked = loaded as { linkedMaxLinks?: number; linkedMaxTagged?: number };
		if (
			loaded.linkedMaxNotes === undefined &&
			(legacyLinked.linkedMaxLinks !== undefined || legacyLinked.linkedMaxTagged !== undefined)
		) {
			this.settings.linkedMaxNotes = Math.min(
				30,
				(legacyLinked.linkedMaxLinks ?? 5) + (legacyLinked.linkedMaxTagged ?? 5),
			);
		}
		delete (this.settings as { linkedMaxLinks?: number }).linkedMaxLinks;
		delete (this.settings as { linkedMaxTagged?: number }).linkedMaxTagged;

		// Coerce out-of-range persisted values back to defaults.
		if (
			!['none', 'active', 'open', 'linked', 'relevant'].includes(this.settings.noteContext)
		) {
			this.settings.noteContext = DEFAULT_SETTINGS.noteContext;
		}
		if (
			typeof this.settings.retrievedMaxNotes !== 'number' ||
			!Number.isFinite(this.settings.retrievedMaxNotes)
		) {
			this.settings.retrievedMaxNotes = DEFAULT_SETTINGS.retrievedMaxNotes;
		} else {
			this.settings.retrievedMaxNotes = Math.min(
				15,
				Math.max(1, Math.round(this.settings.retrievedMaxNotes)),
			);
		}
		if (!['compact', 'standard', 'large', 'max'].includes(this.settings.contextSize)) {
			this.settings.contextSize = DEFAULT_SETTINGS.contextSize;
		}
		if (
			typeof this.settings.maxToolIterations !== 'number' ||
			!Number.isFinite(this.settings.maxToolIterations)
		) {
			this.settings.maxToolIterations = DEFAULT_SETTINGS.maxToolIterations;
		} else {
			this.settings.maxToolIterations = Math.min(
				24,
				Math.max(2, Math.round(this.settings.maxToolIterations)),
			);
		}
		if (
			typeof this.settings.maxOutputTokens !== 'number' ||
			!Number.isFinite(this.settings.maxOutputTokens) ||
			this.settings.maxOutputTokens < 0
		) {
			this.settings.maxOutputTokens = DEFAULT_SETTINGS.maxOutputTokens;
		}
		if (!Array.isArray(this.settings.disabledTools)) {
			this.settings.disabledTools = [];
		}
		if (
			typeof this.settings.linkedMaxNotes !== 'number' ||
			!Number.isFinite(this.settings.linkedMaxNotes)
		) {
			this.settings.linkedMaxNotes = DEFAULT_SETTINGS.linkedMaxNotes;
		} else {
			this.settings.linkedMaxNotes = Math.min(
				30,
				Math.max(0, Math.round(this.settings.linkedMaxNotes)),
			);
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
