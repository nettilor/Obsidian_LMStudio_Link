import { Menu } from 'obsidian';
import type LMStudioNotesPlugin from './main';
import { ALL_TOOL_NAMES, toolCatalog, TOOL_GROUPS } from './tools';

/**
 * Open the shared "which tools can the model use" dropdown. Used from both the
 * settings tab and the chat pane header; both edit the same `disabledTools`
 * set, so the two stay in sync.
 */
export function openToolsMenu(
	plugin: LMStudioNotesPlugin,
	evt: MouseEvent,
	onClose?: () => void,
): void {
	const menu = new Menu();
	const catalog = toolCatalog(plugin.settings);
	const disabled = new Set(plugin.settings.disabledTools);

	const apply = async (names: string[], makeDisabled: boolean) => {
		const next = new Set(plugin.settings.disabledTools);
		for (const n of names) {
			if (makeDisabled) next.add(n);
			else next.delete(n);
		}
		plugin.settings.disabledTools = [...next];
		await plugin.saveSettings();
	};

	menu.addItem((i) =>
		i
			.setTitle('Enable all tools')
			.setIcon('check-check')
			.onClick(() => void apply(ALL_TOOL_NAMES, false)),
	);
	menu.addItem((i) =>
		i
			.setTitle('Disable all tools')
			.setIcon('ban')
			.onClick(() => void apply(ALL_TOOL_NAMES, true)),
	);
	menu.addSeparator();

	for (const group of TOOL_GROUPS) {
		// Only count tools that are actually usable, so the count/checkmark match
		// what the model is really offered (e.g. semantic search needs a model).
		const names = catalog
			.filter((e) => e.group === group && e.available)
			.map((e) => e.name);
		if (names.length === 0) continue;
		const enabledCount = names.filter((n) => !disabled.has(n)).length;
		const allEnabled = enabledCount === names.length;
		menu.addItem((i) =>
			i
				.setTitle(`${group} (${enabledCount}/${names.length})`)
				.setChecked(allEnabled)
				// All on → turn the group off; otherwise turn the whole group on.
				.onClick(() => void apply(names, allEnabled)),
		);
	}

	if (onClose) menu.onHide(onClose);
	menu.showAtMouseEvent(evt);
}
