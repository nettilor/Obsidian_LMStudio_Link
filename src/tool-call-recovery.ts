import { ToolCall } from './lmstudio';

/**
 * Some models (notably gpt-oss / "harmony" format) emit tool calls using
 * control tokens like `to=functions.NAME ... <|message|>{json}`. When the local
 * server fails to parse these into a structured `tool_calls` array, the raw
 * tokens leak into the assistant's text content. These helpers detect and
 * recover such calls so tool use still works.
 */

const TOOL_CALL_MARKERS = [
	'<|message|>',
	'<|call|>',
	'<|channel|>',
	'to=functions.',
];

let recoveryCounter = 0;

/** True when content carries control tokens that indicate a (mis-parsed) tool call. */
export function hasToolCallMarkers(content: string): boolean {
	return TOOL_CALL_MARKERS.some((m) => content.includes(m));
}

/**
 * Best-effort extraction of tool calls leaked into text content. Looks for
 * `functions.<name>` followed by a JSON object and validates the JSON before
 * accepting it. Returns [] when nothing parseable is found.
 */
export function recoverToolCalls(content: string): ToolCall[] {
	const calls: ToolCall[] = [];
	const re = /functions\.([A-Za-z_][A-Za-z0-9_]*)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(content)) !== null) {
		const name = m[1]!;
		const json = extractJsonObject(content, re.lastIndex);
		if (!json) continue;
		try {
			JSON.parse(json);
		} catch {
			continue;
		}
		calls.push({
			id: `recovered-${recoveryCounter++}`,
			type: 'function',
			function: { name, arguments: json },
		});
		const after = content.indexOf(json, re.lastIndex) + json.length;
		if (after > re.lastIndex) re.lastIndex = after;
	}
	return calls;
}

/** Extract the first balanced, string-aware JSON object at/after `from`. */
function extractJsonObject(s: string, from: number): string | null {
	const start = s.indexOf('{', from);
	if (start === -1) return null;
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = start; i < s.length; i++) {
		const c = s[i];
		if (inStr) {
			if (esc) esc = false;
			else if (c === '\\') esc = true;
			else if (c === '"') inStr = false;
		} else if (c === '"') {
			inStr = true;
		} else if (c === '{') {
			depth++;
		} else if (c === '}') {
			depth--;
			if (depth === 0) return s.slice(start, i + 1);
		}
	}
	return null;
}
