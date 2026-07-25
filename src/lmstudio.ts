import { requestUrl, RequestUrlResponse } from 'obsidian';
import { splitReasoningText, ThinkTagSplitter } from './reasoning';

/**
 * A client for LM Studio's local OpenAI-compatible server.
 *
 * Two transports are used:
 *
 * - **Streaming** (desktop): Node's `http`/`https` modules, reached through
 *   Electron's `require`. This streams tokens as they are generated and can be
 *   aborted mid-generation — essential UX at local-model speeds. Node requests
 *   are not subject to the CORS wall of Obsidian's `app://obsidian.md` origin.
 * - **Buffered** (fallback, e.g. mobile): Obsidian's `requestUrl`, which also
 *   bypasses CORS but buffers the whole response and cannot stream or abort.
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
	/** Cap on generated tokens; omit for the server default (unlimited). */
	maxTokens?: number;
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

export interface StreamStats {
	/** Completion tokens, from server usage when reported (else estimated). */
	tokens: number;
	seconds: number;
}

export interface StreamResult extends CompletionResult {
	/** Chain-of-thought emitted by reasoning models, separated from the answer. */
	reasoning: string;
	/** True when generation was stopped by the caller; `message` holds the partial. */
	aborted: boolean;
	stats: StreamStats;
}

export interface StreamHandlers {
	/** Called per visible-text delta with the delta and the accumulated text. */
	onText?(delta: string, full: string): void;
	/** Called per reasoning delta with the delta and the accumulated reasoning. */
	onReasoning?(delta: string, full: string): void;
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
			reasoning_content?: string | null;
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

/** One parsed SSE chunk of a streamed chat completion. */
interface StreamChunk {
	model?: string;
	choices?: Array<{
		delta?: {
			content?: string | null;
			reasoning_content?: string | null;
			reasoning?: string | null;
			tool_calls?: Array<{
				index?: number;
				id?: string;
				function?: { name?: string; arguments?: string };
			}>;
		};
		finish_reason?: string | null;
	}>;
	usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
	error?: { message?: string } | string;
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

type HttpModule = typeof import('node:http');

/**
 * The Node http/https module for the given protocol, when running on desktop
 * (Electron exposes `require`). Null on mobile — callers must fall back to the
 * buffered transport.
 */
function nodeHttpModule(protocol: string): HttpModule | null {
	const req = (window as { require?: (id: string) => unknown }).require;
	if (!req) return null;
	try {
		return req(protocol === 'https:' ? 'https' : 'http') as HttpModule;
	} catch {
		return null;
	}
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

	private completionBody(
		messages: WireMessage[],
		opts: CompleteOptions,
		stream: boolean,
	): Record<string, unknown> {
		const body: Record<string, unknown> = {
			model: opts.model,
			messages,
			temperature: opts.temperature ?? 0.7,
			stream,
		};
		if (typeof opts.maxTokens === 'number' && opts.maxTokens > 0) {
			body.max_tokens = opts.maxTokens;
		}
		if (opts.tools && opts.tools.length > 0) {
			body.tools = opts.tools;
			body.tool_choice = 'auto';
		}
		if (stream) body.stream_options = { include_usage: true };
		return body;
	}

	/**
	 * Run a chat completion that may include tool definitions, returning the
	 * full assistant message (text and/or tool calls) for the caller's loop.
	 */
	async complete(
		messages: WireMessage[],
		opts: CompleteOptions,
	): Promise<CompletionResult> {
		const json = await this.request<ChatCompletionResponse>(
			'POST',
			'/chat/completions',
			this.completionBody(messages, opts, false),
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

	/**
	 * Streamed chat completion. Token deltas are delivered through `handlers`
	 * as they arrive; reasoning (`<think>` blocks or `reasoning_content`) is
	 * split from the visible answer. Aborting via `signal` resolves with the
	 * partial result (`aborted: true`) instead of rejecting.
	 *
	 * Falls back to a buffered completion when Node's http module is not
	 * available (mobile); handlers then fire once with the whole message.
	 */
	async completeStream(
		messages: WireMessage[],
		opts: CompleteOptions,
		handlers: StreamHandlers = {},
		signal?: AbortSignal,
	): Promise<StreamResult> {
		const urlStr = this.url('/chat/completions');
		let url: URL | null = null;
		try {
			url = new URL(urlStr);
		} catch {
			url = null;
		}
		const mod = url ? nodeHttpModule(url.protocol) : null;
		if (!url || !mod) return this.completeBuffered(messages, opts, handlers);

		const payload = JSON.stringify(this.completionBody(messages, opts, true));
		const { apiKey } = this.getConfig();
		const started = Date.now();

		return await new Promise<StreamResult>((resolve, reject) => {
			const splitter = new ThinkTagSplitter();
			let text = '';
			let reasoning = '';
			let model: string | undefined;
			const toolCalls: ToolCall[] = [];
			let usageTokens: number | undefined;
			let settled = false;
			let aborted = false;
			let lineBuf = '';
			let errorBody = '';
			let statusCode = 0;

			const emitText = (delta: string) => {
				if (!delta) return;
				text += delta;
				handlers.onText?.(delta, text);
			};
			const emitReasoning = (delta: string) => {
				if (!delta) return;
				reasoning += delta;
				handlers.onReasoning?.(delta, reasoning);
			};

			const finish = () => {
				if (settled) return;
				settled = true;
				const rest = splitter.flush();
				emitText(rest.text);
				emitReasoning(rest.reasoning);
				toolCalls.forEach((c, i) => {
					if (!c.id) c.id = `call_${i}`;
				});
				const seconds = (Date.now() - started) / 1000;
				resolve({
					message: {
						role: 'assistant',
						content: text || (toolCalls.length ? null : ''),
						tool_calls: toolCalls.length ? toolCalls : undefined,
					},
					model,
					reasoning: reasoning.trim(),
					aborted,
					stats: {
						tokens:
							usageTokens ?? Math.round((text.length + reasoning.length) / 4),
						seconds,
					},
				});
			};
			const fail = (e: LMStudioError) => {
				if (settled) return;
				settled = true;
				reject(e);
			};

			const handleLine = (line: string) => {
				if (!line.startsWith('data:')) return;
				const data = line.slice(5).trim();
				if (!data || data === '[DONE]') return;
				let chunk: StreamChunk;
				try {
					chunk = JSON.parse(data) as StreamChunk;
				} catch {
					return; // tolerate malformed keep-alive/partial lines
				}
				if (chunk.error) {
					const msg =
						typeof chunk.error === 'string'
							? chunk.error
							: (chunk.error.message ?? 'unknown server error');
					fail(new LMStudioError(`LM Studio error: ${msg}`));
					return;
				}
				if (chunk.model) model = chunk.model;
				if (typeof chunk.usage?.completion_tokens === 'number') {
					usageTokens = chunk.usage.completion_tokens;
				}
				const delta = chunk.choices?.[0]?.delta;
				if (!delta) return;
				if (typeof delta.content === 'string' && delta.content) {
					const split = splitter.push(delta.content);
					emitText(split.text);
					emitReasoning(split.reasoning);
				}
				const sepReasoning = delta.reasoning_content ?? delta.reasoning;
				if (typeof sepReasoning === 'string') emitReasoning(sepReasoning);
				for (const tc of delta.tool_calls ?? []) {
					const idx = tc.index ?? 0;
					while (toolCalls.length <= idx) {
						toolCalls.push({
							id: '',
							type: 'function',
							function: { name: '', arguments: '' },
						});
					}
					const target = toolCalls[idx]!;
					if (tc.id) target.id = tc.id;
					if (tc.function?.name) target.function.name += tc.function.name;
					if (tc.function?.arguments) {
						target.function.arguments += tc.function.arguments;
					}
				}
			};

			const req = mod.request(
				url,
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Content-Length': new TextEncoder().encode(payload).length,
						Authorization: `Bearer ${apiKey || 'lm-studio'}`,
						Accept: 'text/event-stream',
					},
				},
				(res) => {
					statusCode = res.statusCode ?? 0;
					res.setEncoding('utf8');
					res.on('data', (part: string) => {
						if (statusCode >= 400) {
							errorBody += part;
							return;
						}
						lineBuf += part;
						let nl: number;
						while ((nl = lineBuf.indexOf('\n')) !== -1) {
							const line = lineBuf.slice(0, nl).trim();
							lineBuf = lineBuf.slice(nl + 1);
							handleLine(line);
						}
					});
					res.on('end', () => {
						if (statusCode >= 400) {
							fail(
								new LMStudioError(
									`LM Studio returned HTTP ${statusCode}${serverText(errorBody)}`,
								),
							);
						} else {
							finish();
						}
					});
					res.on('error', () => {
						if (aborted) finish();
						else fail(new LMStudioError('The connection to LM Studio was lost mid-response.'));
					});
				},
			);

			req.on('error', (e: Error) => {
				if (aborted) {
					finish();
					return;
				}
				fail(
					new LMStudioError(
						`Could not reach LM Studio at ${urlStr}. Is the local server running ` +
							`(LM Studio → Developer → Start Server)? Details: ${e.message}`,
					),
				);
			});

			if (signal) {
				const onAbort = () => {
					aborted = true;
					req.destroy();
					// Some Node versions swallow destroy() without an 'error' event.
					finish();
				};
				if (signal.aborted) onAbort();
				else signal.addEventListener('abort', onAbort, { once: true });
			}

			req.write(payload);
			req.end();
		});
	}

	/** Buffered fallback for `completeStream` (no Node http, e.g. mobile). */
	private async completeBuffered(
		messages: WireMessage[],
		opts: CompleteOptions,
		handlers: StreamHandlers,
	): Promise<StreamResult> {
		const started = Date.now();
		const { message, model } = await this.complete(messages, opts);
		const split =
			typeof message.content === 'string'
				? splitReasoningText(message.content)
				: { text: '', reasoning: '' };
		if (split.reasoning) handlers.onReasoning?.(split.reasoning, split.reasoning);
		if (split.text) handlers.onText?.(split.text, split.text);
		return {
			message: {
				...message,
				content: message.content === null ? null : split.text,
			},
			model,
			reasoning: split.reasoning,
			aborted: false,
			stats: {
				tokens: Math.round((split.text.length + split.reasoning.length) / 4),
				seconds: (Date.now() - started) / 1000,
			},
		};
	}

	/** Convenience wrapper for plain text-in/text-out completions (no tools). */
	async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
		const { message, model } = await this.complete(messages, opts);
		const content =
			typeof message.content === 'string'
				? splitReasoningText(message.content).text
				: '';
		return { content, model };
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

/** Best-effort extraction of a human-readable error from a raw response body. */
function serverText(body: string): string {
	const trimmed = body.trim();
	if (!trimmed) return '.';
	try {
		const err = JSON.parse(trimmed) as ErrorResponse;
		if (err?.error?.message) return `: ${err.error.message}`;
	} catch {
		// Not JSON; use the raw text.
	}
	return `: ${trimmed.slice(0, 300)}`;
}
