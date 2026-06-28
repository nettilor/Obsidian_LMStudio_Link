import { App, Modal, Setting } from 'obsidian';
import { DiffResult } from './diff';

export interface ConfirmRequest {
	title: string;
	/** Target label, e.g. the note path. */
	label?: string;
	/** A line diff to render (preferred). */
	diff?: DiffResult;
	/** Fallback plain-text description when there's no diff. */
	detail?: string;
}

/**
 * A yes/no modal used to confirm a model-requested edit before it touches the
 * vault. Renders a git-style diff when one is provided, else a text summary.
 * Resolves exactly once: true on approve, false on cancel/dismiss.
 */
class ConfirmModal extends Modal {
	private resolved = false;

	constructor(
		app: App,
		private req: ConfirmRequest,
		private onResult: (ok: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.req.title);
		if (this.req.diff) this.modalEl.addClass('lmstudio-notes-diff-modal');

		if (this.req.label) {
			const head = this.contentEl.createDiv({ cls: 'lmstudio-notes-diff-head' });
			head.createSpan({ cls: 'lmstudio-notes-diff-path', text: this.req.label });
			if (this.req.diff) {
				head.createSpan({
					cls: 'lmstudio-notes-diff-stat',
					text: `+${this.req.diff.added}  −${this.req.diff.removed}`,
				});
			}
		}

		if (this.req.diff) {
			this.renderDiff(this.req.diff);
		} else {
			this.contentEl.createEl('pre', {
				text: this.req.detail ?? '',
				cls: 'lmstudio-notes-confirm-detail',
			});
		}

		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText('Cancel').onClick(() => this.finish(false)))
			.addButton((b) =>
				b
					.setButtonText('Apply edit')
					.setCta()
					.onClick(() => this.finish(true)),
			);
	}

	private renderDiff(diff: DiffResult): void {
		const box = this.contentEl.createDiv({ cls: 'lmstudio-notes-diff' });
		for (const row of diff.rows) {
			const line = box.createDiv({
				cls: `lmstudio-notes-diff-row lmstudio-notes-diff-${row.type}`,
			});
			const marker = row.type === 'add' ? '+' : row.type === 'del' ? '−' : '';
			line.createSpan({ cls: 'lmstudio-notes-diff-marker', text: marker });
			// Non-breaking space keeps empty/blank lines visible with height.
			line.createSpan({ cls: 'lmstudio-notes-diff-text', text: row.text || ' ' });
		}
	}

	onClose(): void {
		this.finish(false);
	}

	private finish(ok: boolean): void {
		if (this.resolved) return;
		this.resolved = true;
		this.onResult(ok);
		this.close();
	}
}

export function confirmEdit(app: App, req: ConfirmRequest): Promise<boolean> {
	return new Promise((resolve) => {
		new ConfirmModal(app, req, resolve).open();
	});
}
