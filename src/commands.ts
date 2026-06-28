import { Editor, MarkdownFileInfo, MarkdownView, Notice } from 'obsidian';
import type LMStudioNotesPlugin from './main';
import { describeError } from './lmstudio';
import { summarizeActiveNote } from './summarize';

/**
 * Register all user-facing commands and the ribbon icon. Command ids are
 * stable and must not be renamed once released.
 */
export function registerCommands(plugin: LMStudioNotesPlugin): void {
	plugin.addCommand({
		id: 'open-chat',
		name: 'Open chat',
		callback: () => void plugin.activateChatView(),
	});

	plugin.addCommand({
		id: 'summarize-note',
		name: 'Summarize current note',
		callback: () => summarizeActiveNote(plugin),
	});

	plugin.addCommand({
		id: 'summarize-selection',
		name: 'Summarize selection',
		editorCheckCallback: (
			checking: boolean,
			editor: Editor,
			_ctx: MarkdownView | MarkdownFileInfo,
		) => {
			const hasSelection = editor.getSelection().trim().length > 0;
			if (!hasSelection) return false;
			if (!checking) void summarizeActiveNote(plugin, { selectionOnly: true });
			return true;
		},
	});

	plugin.addCommand({
		id: 'rebuild-semantic-index',
		name: 'Rebuild semantic index',
		callback: async () => {
			if (!plugin.settings.embeddingModel) {
				new Notice('Set an embedding model in the plugin settings first.');
				return;
			}
			const progress = new Notice('Building semantic index…', 0);
			try {
				await plugin.semanticIndex.rebuild((done, total) =>
					progress.setMessage(`Indexing ${done}/${total} notes…`),
				);
				new Notice('Semantic index built.');
			} catch (e) {
				new Notice(describeError(e));
			} finally {
				progress.hide();
			}
		},
	});

	plugin.addCommand({
		id: 'test-connection',
		name: 'Test LM Studio connection',
		callback: async () => {
			try {
				const models = await plugin.client.listModels();
				new Notice(
					models.length
						? `Connected to LM Studio. ${models.length} model(s) available.`
						: 'Connected, but no models are loaded in LM Studio.',
				);
			} catch (e) {
				new Notice(describeError(e));
			}
		},
	});

	plugin.addRibbonIcon('messages-square', 'Open LM Studio chat', () =>
		void plugin.activateChatView(),
	);

	plugin.addRibbonIcon('scroll-text', 'Summarize current note (LM Studio)', () =>
		summarizeActiveNote(plugin),
	);
}
