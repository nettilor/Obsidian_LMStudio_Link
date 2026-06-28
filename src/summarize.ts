import { Notice } from 'obsidian';
import type LMStudioNotesPlugin from './main';
import { describeError } from './lmstudio';
import { asCallout, getActiveNote, insertIntoNote } from './note-context';

/** Roughly cap how much text we send so we don't blow past the context window. */
const MAX_CHARS = 24_000;

interface SummarizeOptions {
	/** When true, summarize the current selection instead of the whole note. */
	selectionOnly?: boolean;
}

/**
 * Read the active note (or selection), ask LM Studio for a summary, and insert
 * it back into the note according to the user's settings. Reentrancy is guarded
 * by `plugin.summarizing` so double-firing can't stack notices or insert twice.
 */
export async function summarizeActiveNote(
	plugin: LMStudioNotesPlugin,
	opts: SummarizeOptions = {},
): Promise<void> {
	if (plugin.summarizing) {
		new Notice('A summary is already in progress…');
		return;
	}
	plugin.summarizing = true;

	const { settings, client, app } = plugin;
	let progress: Notice | null = null;

	try {
		if (!settings.model) {
			new Notice(
				'No model selected. Open the plugin settings, refresh the model list, ' +
					'and choose one.',
			);
			return;
		}

		const note = await getActiveNote(app);
		if (!note) {
			new Notice(
				'Open a note first — there is nothing in the active pane to summarize.',
			);
			return;
		}

		const source = opts.selectionOnly ? note.selection : note.content;
		if (!source || !source.trim()) {
			new Notice(
				opts.selectionOnly ? 'Select some text to summarize.' : 'This note is empty.',
			);
			return;
		}

		const { text, truncated } = clamp(source, MAX_CHARS);
		progress = new Notice('Summarizing with LM Studio…', 0);

		const { content } = await client.chat(
			[
				{ role: 'system', content: settings.summarySystemPrompt },
				{
					role: 'user',
					content:
						`Summarize the following note titled "${note.file.basename}".` +
						(truncated ? ' (Note was truncated to fit the context window.)' : '') +
						`\n\n---\n${text}`,
				},
			],
			{ model: settings.model, temperature: settings.temperature },
		);

		const summary = content.trim();
		if (!summary) {
			new Notice('The model returned an empty summary.');
			return;
		}

		const block = settings.summaryAsCallout
			? asCallout('summary', 'Summary', summary)
			: `## Summary\n\n${summary}\n`;

		await insertIntoNote(app, note, block, settings.summaryInsertLocation);
		new Notice(`Summary inserted into "${note.file.basename}".`);
	} catch (e) {
		new Notice(describeError(e));
	} finally {
		progress?.hide();
		plugin.summarizing = false;
	}
}

function clamp(text: string, max: number): { text: string; truncated: boolean } {
	if (text.length <= max) return { text, truncated: false };
	return { text: text.slice(0, max), truncated: true };
}
