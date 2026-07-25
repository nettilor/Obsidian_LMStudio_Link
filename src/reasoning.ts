/**
 * Handling for "thinking" models (Qwen3, DeepSeek-R1 distills, etc.) that emit
 * chain-of-thought inside `<think>...</think>` tags. LM Studio separates
 * reasoning into a `reasoning_content` field when its "parse reasoning" option
 * is on, but when it is off (or with some chat templates) the raw tags leak
 * into `content`. These helpers split thought from answer — incrementally for
 * streaming, and on whole strings for buffered responses — so reasoning can be
 * shown folded in the UI and kept OUT of the wire history (where it would
 * otherwise burn context on every following turn).
 */

const OPEN_TAG = '<think>';
const CLOSE_TAG = '</think>';

export interface SplitResult {
	text: string;
	reasoning: string;
}

/** Split a complete assistant message into visible text and reasoning. */
export function splitReasoningText(content: string): SplitResult {
	let text = '';
	let reasoning = '';
	let rest = content;
	for (;;) {
		const open = rest.indexOf(OPEN_TAG);
		if (open === -1) {
			text += rest;
			break;
		}
		text += rest.slice(0, open);
		rest = rest.slice(open + OPEN_TAG.length);
		const close = rest.indexOf(CLOSE_TAG);
		if (close === -1) {
			// Unterminated think block (e.g. generation was cut off mid-thought).
			reasoning += rest;
			break;
		}
		reasoning += rest.slice(0, close);
		rest = rest.slice(close + CLOSE_TAG.length);
	}
	return { text: text.trim(), reasoning: reasoning.trim() };
}

/**
 * Incremental `<think>` splitter for streamed deltas. Tags can be split across
 * chunk boundaries, so any trailing partial tag is held back until the next
 * push (or flush) decides what it was.
 */
export class ThinkTagSplitter {
	private inThink = false;
	private buf = '';

	/** Feed a streamed delta; returns the text/reasoning it releases. */
	push(delta: string): SplitResult {
		this.buf += delta;
		let text = '';
		let reasoning = '';
		for (;;) {
			const tag = this.inThink ? CLOSE_TAG : OPEN_TAG;
			const idx = this.buf.indexOf(tag);
			if (idx === -1) break;
			const before = this.buf.slice(0, idx);
			if (this.inThink) reasoning += before;
			else text += before;
			this.buf = this.buf.slice(idx + tag.length);
			this.inThink = !this.inThink;
		}
		const tag = this.inThink ? CLOSE_TAG : OPEN_TAG;
		const hold = partialTagSuffix(this.buf, tag);
		const emit = this.buf.slice(0, this.buf.length - hold);
		this.buf = this.buf.slice(this.buf.length - hold);
		if (this.inThink) reasoning += emit;
		else text += emit;
		return { text, reasoning };
	}

	/** Release anything still held back at end of stream. */
	flush(): SplitResult {
		const out: SplitResult = this.inThink
			? { text: '', reasoning: this.buf }
			: { text: this.buf, reasoning: '' };
		this.buf = '';
		return out;
	}
}

/** Length of the longest suffix of `s` that is a proper prefix of `tag`. */
function partialTagSuffix(s: string, tag: string): number {
	const max = Math.min(s.length, tag.length - 1);
	for (let n = max; n > 0; n--) {
		if (s.endsWith(tag.slice(0, n))) return n;
	}
	return 0;
}
