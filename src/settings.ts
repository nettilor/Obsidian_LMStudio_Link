import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type LMStudioNotesPlugin from './main';
import { InsertLocation } from './note-context';
import { describeError } from './lmstudio';
import { toolCatalog } from './tools';
import { openToolsMenu } from './tool-menu';

/** Which note content is auto-injected into chat context. */
export type NoteContextMode = 'none' | 'active' | 'open' | 'linked';

export interface LMStudioNotesSettings {
	/** OpenAI-compatible base URL. `/v1` is appended automatically if omitted. */
	baseUrl: string;
	/** LM Studio ignores the key, but the OpenAI client shape requires one. */
	apiKey: string;
	/** The model id to send. Empty means "let the user pick one first". */
	model: string;
	/** Sampling temperature for generations. */
	temperature: number;
	/** System prompt used by the summarize commands. */
	summarySystemPrompt: string;
	/** Where a generated summary is placed in the note. */
	summaryInsertLocation: InsertLocation;
	/** Wrap the summary in a `> [!summary]` callout. */
	summaryAsCallout: boolean;
	/** System prompt for the chat pane. */
	chatSystemPrompt: string;
	/** Free-text facts about the vault (conventions, structure) injected into chat. */
	vaultGuide: string;
	/** Inject today's date and the current/adjacent ISO weeks into chat context. */
	includeDateContext: boolean;
	/** Which note content to auto-include as chat context. */
	noteContext: NoteContextMode;
	/** "Current note + links" mode: max related notes to inject (ranked by relevance). */
	linkedMaxNotes: number;
	/** "Current note + links" mode: also follow links 2 hops out. */
	linkedTwoHop: boolean;
	/** Names of tools the model is not allowed to use. */
	disabledTools: string[];
	/** Ask for confirmation before any tool writes to the vault. */
	requireWriteConfirmation: boolean;
	/** Embedding model id used to build the semantic index (separate from chat). */
	embeddingModel: string;
	/** Keep the semantic index updated automatically as notes change. */
	semanticAutoIndex: boolean;
	/** Font size (px) for chat messages and the input box. */
	chatFontSize: number;
}

export const DEFAULT_SUMMARY_PROMPT =
	'You are a concise note-summarizing assistant for a personal knowledge base. ' +
	'Summarize the provided note in clear, faithful bullet points. ' +
	'Capture key ideas, decisions, and action items. Do not invent information ' +
	'that is not present in the note. Respond in Markdown.';

export const DEFAULT_CHAT_PROMPT =
	"You are a helpful assistant embedded in the user's Obsidian vault, powered by " +
	'a local model. You can read the user\'s notes and, when asked, edit them using ' +
	'the provided tools. Prefer calling tools to fetch real note content over ' +
	'guessing. When editing, make minimal, faithful changes and briefly explain what ' +
	'you did. Respond in Markdown.';

export const DEFAULT_SETTINGS: LMStudioNotesSettings = {
	baseUrl: 'http://localhost:1234/v1',
	apiKey: 'lm-studio',
	model: '',
	temperature: 0.3,
	summarySystemPrompt: DEFAULT_SUMMARY_PROMPT,
	summaryInsertLocation: 'top',
	summaryAsCallout: true,
	chatSystemPrompt: DEFAULT_CHAT_PROMPT,
	vaultGuide: '',
	includeDateContext: true,
	noteContext: 'active',
	linkedMaxNotes: 8,
	linkedTwoHop: false,
	disabledTools: [],
	requireWriteConfirmation: true,
	embeddingModel: '',
	semanticAutoIndex: true,
	chatFontSize: 14,
};

export class LMStudioNotesSettingTab extends PluginSettingTab {
	plugin: LMStudioNotesPlugin;
	/** Cached model list for the dropdown; refreshed on demand. */
	private availableModels: string[] = [];

	constructor(app: App, plugin: LMStudioNotesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * Cache a fresh model list, auto-select one when none is chosen (so the
	 * dropdown's displayed value can never diverge from settings.model), and
	 * re-render.
	 */
	private async setModels(models: string[]): Promise<void> {
		this.availableModels = models;
		if (!this.plugin.settings.model && models.length > 0) {
			this.plugin.settings.model = models[0]!;
			await this.plugin.saveSettings();
		}
		this.display();
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName('Connection').setHeading();

		new Setting(containerEl)
			.setName('LM Studio server URL')
			.setDesc(
				"Base URL of LM Studio's local server. The default is correct for a " +
					'standard LM Studio install. `/v1` is added automatically if you omit it.',
			)
			.addText((text) =>
				text
					.setPlaceholder('http://localhost:1234/v1')
					.setValue(this.plugin.settings.baseUrl)
					.onChange(async (value) => {
						this.plugin.settings.baseUrl = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('API key')
			.setDesc(
				'LM Studio ignores this, but a placeholder is required. Leave as is ' +
					'unless you put a proxy in front of LM Studio.',
			)
			.addText((text) => {
				text.inputEl.type = 'password';
				text
					.setPlaceholder('lm-studio')
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Test connection')
			.setDesc('Verify Obsidian can reach LM Studio and list its models.')
			.addButton((btn) =>
				btn
					.setButtonText('Test')
					.onClick(async () => {
						btn.setDisabled(true).setButtonText('Testing…');
						try {
							const models = await this.plugin.client.listModels();
							if (models.length === 0) {
								this.availableModels = [];
								new Notice(
									'Connected to LM Studio, but no models are loaded. ' +
										'Load a model in LM Studio, then refresh.',
								);
							} else {
								new Notice(`Connected. ${models.length} model(s) available.`);
								await this.setModels(models);
							}
						} catch (e) {
							new Notice(describeError(e));
						} finally {
							btn.setDisabled(false).setButtonText('Test');
						}
					}),
			);

		new Setting(containerEl).setName('Model').setHeading();

		const modelSetting = new Setting(containerEl)
			.setName('Model')
			.setDesc(
				this.plugin.settings.model
					? 'The model used for all generations.'
					: 'Select a model. Use “Refresh” to load the list from LM Studio.',
			);

		modelSetting.addDropdown((dropdown) => {
			const options = new Set(this.availableModels);
			// Always include the currently-saved model so it stays selectable.
			if (this.plugin.settings.model) options.add(this.plugin.settings.model);

			if (options.size === 0) {
				dropdown.addOption('', '— refresh to load models —');
				dropdown.setDisabled(true);
			} else {
				for (const id of options) dropdown.addOption(id, id);
				dropdown.setValue(this.plugin.settings.model || '');
			}

			dropdown.onChange(async (value) => {
				this.plugin.settings.model = value;
				await this.plugin.saveSettings();
			});
		});

		modelSetting.addExtraButton((btn) =>
			btn
				.setIcon('refresh-cw')
				.setTooltip('Refresh model list from LM Studio')
				.onClick(async () => {
					try {
						const models = await this.plugin.client.listModels();
						if (models.length === 0) new Notice('No models loaded in LM Studio.');
						await this.setModels(models);
					} catch (e) {
						new Notice(describeError(e));
					}
				}),
		);

		new Setting(containerEl)
			.setName('Temperature')
			.setDesc('Lower is more focused and deterministic; higher is more creative.')
			.addSlider((slider) =>
				slider
					.setLimits(0, 1, 0.05)
					.setValue(this.plugin.settings.temperature)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.temperature = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName('Summarize').setHeading();

		new Setting(containerEl)
			.setName('Summary system prompt')
			.setDesc('Instructions sent to the model when summarizing a note.')
			.addTextArea((area) => {
				area.inputEl.rows = 6;
				area.inputEl.addClass('lmstudio-notes-prompt');
				area
					.setValue(this.plugin.settings.summarySystemPrompt)
					.onChange(async (value) => {
						this.plugin.settings.summarySystemPrompt = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Insert summary at')
			.setDesc('Where the generated summary is placed in the note.')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('top', 'Top of note (below frontmatter)')
					.addOption('bottom', 'Bottom of note')
					.addOption('cursor', 'At cursor')
					.setValue(this.plugin.settings.summaryInsertLocation)
					.onChange(async (value) => {
						this.plugin.settings.summaryInsertLocation =
							value as InsertLocation;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Format as callout')
			.setDesc('Wrap the summary in a > [!summary] callout block.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.summaryAsCallout)
					.onChange(async (value) => {
						this.plugin.settings.summaryAsCallout = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName('Chat').setHeading();

		new Setting(containerEl)
			.setName('Chat system prompt')
			.setDesc('Instructions sent to the model at the start of every chat.')
			.addTextArea((area) => {
				area.inputEl.rows = 6;
				area.inputEl.addClass('lmstudio-notes-prompt');
				area
					.setValue(this.plugin.settings.chatSystemPrompt)
					.onChange(async (value) => {
						this.plugin.settings.chatSystemPrompt = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Note context')
			.setDesc(
				'Which note content to automatically include so the model knows what ' +
					'you are working on. "All open notes" sends every open tab; ' +
					'"Current note + links" adds the note\'s linked and tag-related notes.',
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption('none', 'None')
					.addOption('active', 'Active note')
					.addOption('open', 'All open notes')
					.addOption('linked', 'Current note + links')
					.setValue(this.plugin.settings.noteContext)
					.onChange(async (value) => {
						this.plugin.settings.noteContext = value as NoteContextMode;
						await this.plugin.saveSettings();
						this.plugin.refreshChatViews();
					}),
			);

		new Setting(containerEl)
			.setName('Linked context: max related notes')
			.setDesc(
				'For "Current note + links": how many related notes to include, ranked ' +
					'by relevance — rare shared tags weigh most, then links.',
			)
			.addSlider((slider) =>
				slider
					.setLimits(0, 30, 1)
					.setValue(this.plugin.settings.linkedMaxNotes)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.linkedMaxNotes = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Linked context: follow links 2 hops')
			.setDesc(
				'For "Current note + links": also include notes linked from the linked ' +
					'notes (still capped by the linked-notes limit above).',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.linkedTwoHop)
					.onChange(async (value) => {
						this.plugin.settings.linkedTwoHop = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName('Vault context').setHeading();

		new Setting(containerEl)
			.setName('Vault notes')
			.setDesc(
				'Facts about your vault the model should always know — folder layout, ' +
					'naming conventions, templates. Injected into every chat.',
			)
			.addTextArea((area) => {
				area.inputEl.rows = 5;
				area.inputEl.addClass('lmstudio-notes-prompt');
				area.setPlaceholder(
					'e.g. Weekly notes are in Journal/Weekly, named "YYYY-Www" (e.g. 2026-W26).\n' +
						'Daily notes are in Journal/Daily, named YYYY-MM-DD.\n' +
						'Tasks use "- [ ]" checkboxes.',
				);
				area
					.setValue(this.plugin.settings.vaultGuide)
					.onChange(async (value) => {
						this.plugin.settings.vaultGuide = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Include current date & week')
			.setDesc(
				"Tell the model today's date and the current/last/next ISO week (e.g. " +
					'2026-W26), so "this week" / "last week" resolve correctly.',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.includeDateContext)
					.onChange(async (value) => {
						this.plugin.settings.includeDateContext = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName('Tools').setHeading();

		const available = toolCatalog(this.plugin.settings).filter((e) => e.available);
		const enabledCount = available.filter(
			(e) => !this.plugin.settings.disabledTools.includes(e.name),
		).length;
		new Setting(containerEl)
			.setName('Available tools')
			.setDesc(
				`${enabledCount} of ${available.length} enabled. Choose which vault tools the ` +
					'model may call (reading, search, graph, editing). Disable reading/search/' +
					'graph tools when you already inject note content as context.',
			)
			.addButton((btn) =>
				btn.setButtonText('Configure…').onClick((evt) => {
					openToolsMenu(this.plugin, evt, () => this.display());
				}),
			);

		new Setting(containerEl)
			.setName('Confirm before edits')
			.setDesc('Ask for confirmation before the model writes anything to the vault.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.requireWriteConfirmation)
					.onChange(async (value) => {
						this.plugin.settings.requireWriteConfirmation = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName('Appearance').setHeading();

		new Setting(containerEl)
			.setName('Chat font size')
			.setDesc('Font size (in pixels) for chat messages and the input box.')
			.addSlider((slider) =>
				slider
					.setLimits(11, 24, 1)
					.setValue(this.plugin.settings.chatFontSize)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.chatFontSize = value;
						await this.plugin.saveSettings();
						this.plugin.refreshChatViews();
					}),
			);

		this.renderSemanticSearch(containerEl);
	}

	private renderSemanticSearch(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Semantic search').setHeading();

		new Setting(containerEl)
			.setName('Embedding model')
			.setDesc(
				'A model used to build the local search index, separate from the chat ' +
					'model. Load an embedding model in LM Studio (e.g. nomic-embed-text), ' +
					'then refresh and pick it here.',
			)
			.addDropdown((dropdown) => {
				const options = new Set(this.availableModels);
				if (this.plugin.settings.embeddingModel) {
					options.add(this.plugin.settings.embeddingModel);
				}
				if (options.size === 0) {
					dropdown.addOption('', '— refresh models —');
					dropdown.setDisabled(true);
				} else {
					dropdown.addOption('', '— none —');
					for (const id of options) dropdown.addOption(id, id);
					dropdown.setValue(this.plugin.settings.embeddingModel || '');
				}
				dropdown.onChange(async (value) => {
					this.plugin.settings.embeddingModel = value;
					await this.plugin.saveSettings();
				});
			})
			.addExtraButton((btn) =>
				btn
					.setIcon('refresh-cw')
					.setTooltip('Refresh model list from LM Studio')
					.onClick(async () => {
						try {
							this.availableModels = await this.plugin.client.listModels();
						} catch (e) {
							new Notice(describeError(e));
						}
						this.display();
					}),
			);

		new Setting(containerEl)
			.setName('Keep index updated automatically')
			.setDesc('Re-embed notes as you change them (only once the index is built).')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.semanticAutoIndex)
					.onChange(async (value) => {
						this.plugin.settings.semanticAutoIndex = value;
						await this.plugin.saveSettings();
					}),
			);

		const indexSetting = new Setting(containerEl)
			.setName('Semantic index')
			.setDesc('Loading status…')
			.addButton((btn) =>
				btn.setButtonText('Build / rebuild').onClick(async () => {
					if (!this.plugin.settings.embeddingModel) {
						new Notice('Pick an embedding model first.');
						return;
					}
					const progress = new Notice('Building semantic index…', 0);
					try {
						await this.plugin.semanticIndex.rebuild((done, total) =>
							progress.setMessage(`Indexing ${done}/${total} notes…`),
						);
						new Notice('Semantic index built.');
					} catch (e) {
						new Notice(describeError(e));
					} finally {
						progress.hide();
						this.display();
					}
				}),
			)
			.addExtraButton((btn) =>
				btn
					.setIcon('trash')
					.setTooltip('Clear the index')
					.onClick(async () => {
						await this.plugin.semanticIndex.clear();
						new Notice('Semantic index cleared.');
						this.display();
					}),
			);

		// Status is async; fill it in once the index file has loaded.
		void (async () => {
			await this.plugin.semanticIndex.load();
			const s = this.plugin.semanticIndex.status();
			indexSetting.setDesc(
				s.built
					? `Indexed ${s.files} notes (${s.chunks} chunks), model: ${s.model || '?'}.`
					: 'Not built yet.',
			);
		})();
	}
}
