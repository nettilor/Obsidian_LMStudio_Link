import { requestUrl, RequestUrlResponse } from 'obsidian';

/**
 * A minimal client for LM Studio's local OpenAI-compatible server.
 *
 * All requests go through Obsidian's `requestUrl`, which makes the call
 * outside the browser sandbox and therefore bypasses the CORS wall that
 * Obsidian's Electron origin (`app://obsidian.md`) would otherwise hit when
 * talking to `http://localhost:1234`. The tradeoff is that `requestUrl`
 * buffers the whole response, so this client does not stream tokens.
 */

/** A function the model may call, described with an OpenAI-style JSON schema. */
export interface ToolDef {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

/** A tool invocation requested by the model. `arguments` is a JSON string. */
export interface ToolCall {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

/** A message in the OpenAI chat wire format (covers tool calls + tool results). */
export interface WireMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | null;
	tool_calls?: ToolCall[];
	tool_call_id?: string;
}

/** A simple text message (the subset used by non-tool callers like summarize). */
export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface ChatOptions {
	model: string;
	temperature?: number;
}

export interface CompleteOptions extends ChatOptions {
	tools?: ToolDef[];
}

export interface AssistantMessage {
	role: 'assistant';
	content: string | null;
	tool_calls?: ToolCall[];
}

export interface CompletionResult {
	message: AssistantMessage;
	/** The model id the server reports having used, when available. */
	model?: string;
}

export interface ChatResult {
	content: string;
	model?: string;
}

/** Raised for any failure talking to LM Studio. The message is user-facing. */
export class LMStudioError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'LMStudioError';
	}
}

export interface LMStudioConfig {
	baseUrl: string;
	apiKey: string;
}

interface ModelsResponse {
	data?: Array<{ id?: string }>;
}

interface ChatCompletionResponse {
	model?: string;
	choices?: Array<{
		message?: {
			role?: string;
			content?: string | null;
			tool_calls?: ToolCall[];
		};
	}>;
}

interface ErrorResponse {
	error?: { message?: string };
}

interface EmbeddingsResponse {
	data?: Array<{ embedding?: number[]; index?: number }>;
}

/**
 * Normalize a user-entered base URL to an OpenAI-compatible root.
 *
 * Appends `/v1` ONLY when the user gave a bare origin with no path, so a
 * standard `http://localhost:1234` becomes `http://localhost:1234/v1`. Any
 * explicit path (`/v1`, the native `/api/v0`, or a reverse-proxy subpath) is
 * left untouched.
 */
export function normalizeBaseUrl(input: string): string {
	const raw = input.trim().replace(/\/+$/, '');
	if (!raw) return 'http://localhost:1234/v1';

	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		// Not a parseable URL; leave it to fail loudly at request time.
		return raw;
	}

	// A path means the user told us where the API root is — respect it.
	if (parsed.pathname && parsed.pathname !== '/') return raw;
	return `${raw}/v1`;
}

/** Turn any thrown value into a single user-facing message string. */
export function describeError(e: unknown): string {
	if (e instanceof LMStudioError) return e.message;
	if (e instanceof Error && e.message) return `Unexpected error: ${e.message}`;
	return `Unexpected error: ${String(e)}`;
}

export class LMStudioClient {
	constructor(private readonly getConfig: () => LMStudioConfig) {}

	private url(path: string): string {
		return `${normalizeBaseUrl(this.getConfig().baseUrl)}${path}`;
	}

	/** List the ids of models currently loaded/available in LM Studio. */
	async listModels(): Promise<string[]> {
		const json = await this.request<ModelsResponse>('GET', '/models');
		const data = json.data ?? [];
		return data
			.map((m) => m.id)
			.filter((id): id is string => typeof id === 'string' && id.length > 0);
	}

	/**
	 * Run a chat completion that may include tool definitions, returning the
	 * full assistant message (text and/or tool calls) for the caller's loop.
	 */
	async complete(
		messages: WireMessage[],
		opts: CompleteOptions,
	): Promise<CompletionResult> {
		const body: Record<string, unknown> = {
			model: opts.model,
			messages,
			temperature: opts.temperature ?? 0.7,
			stream: false,
		};
		if (opts.tools && opts.tools.length > 0) {
			body.tools = opts.tools;
			body.tool_choice = 'auto';
		}

		const json = await this.request<ChatCompletionResponse>(
			'POST',
			'/chat/completions',
			body,
		);
		const msg = json.choices?.[0]?.message;
		if (!msg) {
			throw new LMStudioError(
				'LM Studio returned an empty response. Is a model loaded?',
			);
		}
		return {
			message: {
				role: 'assistant',
				content: typeof msg.content === 'string' ? msg.content : null,
				tool_calls: msg.tool_calls,
			},
			model: json.model,
		};
	}

	/** Convenience wrapper for plain text-in/text-out completions (no tools). */
	async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
		const { message, model } = await this.complete(messages, opts);
		return { content: message.content ?? '', model };
	}

	/** Embed one or more texts, returning a vector per input (in input order). */
	async embed(input: string[], model: string): Promise<number[][]> {
		if (input.length === 0) return [];
		const json = await this.request<EmbeddingsResponse>('POST', '/embeddings', {
			model,
			input,
			encoding_format: 'float',
		});
		const data = (json.data ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
		return data.map((d) => d.embedding ?? []);
	}

	private async request<T>(
		method: 'GET' | 'POST',
		path: string,
		body?: unknown,
	): Promise<T> {
		const { apiKey } = this.getConfig();
		const url = this.url(path);

		let res: RequestUrlResponse;
		try {
			res = await requestUrl({
				url,
				method,
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${apiKey || 'lm-studio'}`,
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				// Handle non-2xx ourselves so we can surface the server's error text.
				throw: false,
			});
		} catch (e) {
			// Thrown for transport-level failures (server down, DNS, refused).
			throw new LMStudioError(
				`Could not reach LM Studio at ${url}. Is the local server running ` +
					`(LM Studio → Developer → Start Server)? Details: ${(e as Error).message}`,
			);
		}

		if (res.status >= 400) {
			throw new LMStudioError(
				`LM Studio returned HTTP ${res.status}${this.serverMessage(res)}`,
			);
		}

		try {
			return res.json as T;
		} catch {
			throw new LMStudioError(
				'LM Studio returned a response that was not valid JSON.',
			);
		}
	}

	/** Best-effort extraction of a human-readable error from a failed response. */
	private serverMessage(res: RequestUrlResponse): string {
		try {
			const err = res.json as ErrorResponse | undefined;
			if (err?.error?.message) return `: ${err.error.message}`;
		} catch {
			// Body wasn't JSON; fall through to plain text.
		}
		const text = typeof res.text === 'string' ? res.text.trim() : '';
		return text ? `: ${text.slice(0, 300)}` : '.';
	}
}
