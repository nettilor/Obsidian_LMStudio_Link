/** A line-level diff for previewing edits, with collapsed unchanged context. */

export type DiffRowType = 'context' | 'add' | 'del' | 'gap';

export interface DiffRow {
	type: DiffRowType;
	text: string;
}

export interface DiffResult {
	rows: DiffRow[];
	added: number;
	removed: number;
	/** True when the change was too large to diff fully and was summarized. */
	truncated: boolean;
}

/** Cap on the LCS table size (changed region only) to keep big edits fast. */
const MAX_MIDDLE_CELLS = 250_000;
/** Cap on rendered rows so the modal DOM stays bounded. */
const MAX_ROWS = 500;

export function lineDiff(before: string, after: string, context = 3): DiffResult {
	const a = before.split('\n');
	const b = after.split('\n');

	// Trim the common prefix and suffix so we only diff the changed region.
	let p = 0;
	while (p < a.length && p < b.length && a[p] === b[p]) p++;
	let ea = a.length;
	let eb = b.length;
	while (ea > p && eb > p && a[ea - 1] === b[eb - 1]) {
		ea--;
		eb--;
	}

	const midA = a.slice(p, ea);
	const midB = b.slice(p, eb);

	let middle: DiffRow[];
	let added: number;
	let removed: number;
	let truncated = false;

	if (midA.length * midB.length > MAX_MIDDLE_CELLS) {
		truncated = true;
		added = midB.length;
		removed = midA.length;
		middle = [{ type: 'gap', text: `… large change: +${added} / −${removed} lines …` }];
	} else {
		middle = lcsDiff(midA, midB);
		added = middle.filter((r) => r.type === 'add').length;
		removed = middle.filter((r) => r.type === 'del').length;
	}

	if (added === 0 && removed === 0 && !truncated) {
		return { rows: [{ type: 'gap', text: '(no changes)' }], added: 0, removed: 0, truncated: false };
	}

	const rows: DiffRow[] = [];
	if (p > context) rows.push(gapRow(p - context));
	for (let i = Math.max(0, p - context); i < p; i++) rows.push({ type: 'context', text: a[i]! });

	rows.push(...middle);

	const suffixLen = a.length - ea; // identical to b.length - eb
	for (let i = ea; i < Math.min(a.length, ea + context); i++) {
		rows.push({ type: 'context', text: a[i]! });
	}
	if (suffixLen > context) rows.push(gapRow(suffixLen - context));

	if (rows.length > MAX_ROWS) {
		rows.length = MAX_ROWS;
		rows.push({ type: 'gap', text: '… diff truncated …' });
		truncated = true;
	}

	return { rows, added, removed, truncated };
}

function gapRow(n: number): DiffRow {
	return { type: 'gap', text: `… ${n} unchanged line${n === 1 ? '' : 's'} …` };
}

/** Classic LCS-backtrack diff over two line arrays. */
function lcsDiff(a: string[], b: string[]): DiffRow[] {
	const m = a.length;
	const n = b.length;
	if (m === 0) return b.map((text) => ({ type: 'add' as const, text }));
	if (n === 0) return a.map((text) => ({ type: 'del' as const, text }));

	const dp: number[][] = Array.from({ length: m + 1 }, () =>
		new Array<number>(n + 1).fill(0),
	);
	for (let i = m - 1; i >= 0; i--) {
		for (let j = n - 1; j >= 0; j--) {
			dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
		}
	}

	const rows: DiffRow[] = [];
	let i = 0;
	let j = 0;
	while (i < m && j < n) {
		if (a[i] === b[j]) {
			rows.push({ type: 'context', text: a[i]! });
			i++;
			j++;
		} else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
			rows.push({ type: 'del', text: a[i]! });
			i++;
		} else {
			rows.push({ type: 'add', text: b[j]! });
			j++;
		}
	}
	while (i < m) rows.push({ type: 'del', text: a[i++]! });
	while (j < n) rows.push({ type: 'add', text: b[j++]! });
	return rows;
}
