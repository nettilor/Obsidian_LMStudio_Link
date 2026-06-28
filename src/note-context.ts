import { App, Editor, MarkdownView, TFile } from 'obsidian';

/** A snapshot of whatever note is open in the active pane. */
export interface ActiveNote {
	file: TFile;
	/** The live markdown view, when the active pane is a markdown editor. */
	view: MarkdownView | null;
	/** The live editor, when available. Prefer this for writes (it's undoable). */
	editor: Editor | null;
	/** Full note text (from the live editor buffer when open, else from disk). */
	content: string;
	/** Currently selected text, or '' when nothing is selected. */
	selection: string;
}

/**
 * Read the note in the active pane. Returns null when there is no active file
 * (e.g. an empty workspace or a non-file view). Reads from the live editor
 * buffer when the file is open so we see unsaved changes.
 */
export async function getActiveNote(app: App): Promise<ActiveNote | null> {
	const file = app.workspace.getActiveFile();
	if (!file) return null;

	// Prefer a loaded markdown editor for this file even when the active view
	// is not a markdown view (e.g. the chat side-pane is focused) — that way we
	// still see unsaved edits and the current selection.
	const view = findMarkdownViewForFile(app, file);
	if (view) {
		return {
			file,
			view,
			editor: view.editor,
			content: view.editor.getValue(),
			selection: view.editor.getSelection(),
		};
	}

	return {
		file,
		view: null,
		editor: null,
		content: await app.vault.cachedRead(file),
		selection: '',
	};
}

/** Find a loaded MarkdownView showing `file`, checking the active view first. */
export function findMarkdownViewForFile(app: App, file: TFile): MarkdownView | null {
	const active = app.workspace.getActiveViewOfType(MarkdownView);
	if (active && active.file === file) return active;
	for (const leaf of app.workspace.getLeavesOfType('markdown')) {
		const view = leaf.view;
		if (view instanceof MarkdownView && view.file === file) return view;
	}
	return null;
}

/** Where generated text should be placed relative to the note. */
export type InsertLocation = 'top' | 'bottom' | 'cursor';

/**
 * Find the 0-indexed line where the note body begins by scanning the provided
 * text directly. We deliberately do NOT use metadataCache.frontmatterPosition:
 * the cache lags the live editor buffer, so a just-edited frontmatter block
 * would yield a stale (possibly out-of-range) line. Returns the line after a
 * closing `---` fence, or 0 when there is no frontmatter.
 */
function bodyStartLine(text: string): number {
	const lines = text.split('\n');
	if ((lines[0]?.trim() ?? '') !== '---') return 0;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i]?.trim() === '---') return i + 1;
	}
	// Unterminated frontmatter — treat the whole note as body.
	return 0;
}

/**
 * Insert `text` into the active note at the requested location.
 *
 * Uses the live `Editor` when the note is open (changes are immediate and
 * undoable with Cmd/Ctrl+Z); otherwise falls back to the atomic
 * `Vault.process` so a background file isn't clobbered by a stale read.
 * All position math is done against the text actually being written, never
 * the metadata cache.
 */
export async function insertIntoNote(
	app: App,
	note: ActiveNote,
	text: string,
	location: InsertLocation,
): Promise<void> {
	const block = text.endsWith('\n') ? text : `${text}\n`;

	if (note.editor) {
		const editor = note.editor;

		if (location === 'cursor') {
			editor.replaceRange(block, editor.getCursor());
			return;
		}

		if (location === 'bottom') {
			appendInEditor(editor, block);
			return;
		}

		// top: insert after frontmatter, computed from the LIVE buffer.
		const start = bodyStartLine(editor.getValue());
		if (start > editor.lastLine()) {
			// Frontmatter-only note (no body lines): append at the very end.
			appendInEditor(editor, block);
		} else {
			editor.replaceRange(block, { line: start, ch: 0 });
		}
		return;
	}

	// No live editor: write the file directly but atomically.
	await app.vault.process(note.file, (data) => {
		if (data === '') return block;
		if (location === 'bottom') {
			return data.endsWith('\n') ? `${data}${block}` : `${data}\n${block}`;
		}
		// 'cursor' has no meaning without an editor; treat as 'top'.
		const lines = data.split('\n');
		lines.splice(bodyStartLine(data), 0, block.replace(/\n$/, ''));
		return lines.join('\n');
	});
}

/** Append a block at the end of the editor, adding a separating newline only when needed. */
function appendInEditor(editor: Editor, block: string): void {
	const lastLine = editor.lastLine();
	const lastCh = editor.getLine(lastLine).length;
	const prefix = lastCh > 0 ? '\n' : '';
	editor.replaceRange(`${prefix}${block}`, { line: lastLine, ch: lastCh });
}

/**
 * Wrap text in an Obsidian callout block, e.g.
 * `> [!summary] Title` followed by `> `-prefixed body lines.
 */
export function asCallout(type: string, title: string, body: string): string {
	const quoted = body
		.trim()
		.split('\n')
		.map((line) => (line.length ? `> ${line}` : '>'))
		.join('\n');
	return `> [!${type}] ${title}\n${quoted}\n`;
}
