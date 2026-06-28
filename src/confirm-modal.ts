import { App, Modal, Setting } from 'obsidian';

/**
 * A yes/no modal used to confirm a model-requested edit before it touches the
 * vault. Resolves exactly once: true on approve, false on cancel/dismiss.
 */
class ConfirmModal extends Modal {
	private resolved = false;

	constructor(
		app: App,
		private opts: { title: string; detail: string; onResult: (ok: boolean) => void },
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.opts.title);
		this.contentEl.createEl('pre', {
			text: this.opts.detail,
			cls: 'lmstudio-notes-confirm-detail',
		});

		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText('Cancel').onClick(() => this.finish(false)))
			.addButton((b) =>
				b
					.setButtonText('Apply edit')
					.setCta()
					.onClick(() => this.finish(true)),
			);
	}

	onClose(): void {
		// Covers dismissal via Esc or clicking outside.
		this.finish(false);
	}

	private finish(ok: boolean): void {
		if (this.resolved) return;
		this.resolved = true;
		this.opts.onResult(ok);
		this.close();
	}
}

export function confirmEdit(app: App, title: string, detail: string): Promise<boolean> {
	return new Promise((resolve) => {
		new ConfirmModal(app, { title, detail, onResult: resolve }).open();
	});
}
