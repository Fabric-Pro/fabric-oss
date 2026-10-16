/**
 * Aborting an MCP tool call aborts its HTTP request, on both the Streamable
 * HTTP and the SSE transport (Fizzy #3071). `@ai-sdk/mcp` hands the call's
 * signal to `transport.send`, which the SDK transports ignore; the transport
 * `createMcpClient` builds carries it to the request through an ambient
 * scope (`withCallSignalScope`) read by the outermost transport `fetch`
 * (`abortWritesWithCallSignal`).
 *
 * Runs the real AI SDK MCP client over the real SDK transports; only the
 * server is simulated, by the `fetch` the client is given. Its `tools/call`
 * hangs until the request's own signal aborts, as a slow server would.
 */

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	getMcpConfigById: vi.fn(),
	getValidAccessToken: vi.fn(),
	getMcpConfigByIdInternal: vi.fn(),
	getMcpOAuthGrantGeneration: vi.fn(),
	canConnectOrganizationMcpConfigs: async () => true,
	canReadOrganizationMcpConfigs: async () => true,
	isOrganizationMember: async () => true,
}));

// The destination check resolves DNS; not under test here.
vi.mock("../server-url-guard", async (importOriginal) => ({
	...(await importOriginal<typeof import("../server-url-guard")>()),
	assertMcpServerUrlResolved: async () => undefined,
}));

import {
	abortWritesWithCallSignal,
	withCallSignalScope,
} from "../call-abort-signal";
import { createMcpClient, type McpClientType } from "../client";
import type { GitLabMcpFetch } from "../gitlab-credential";

const SERVER = "https://mcp.example.com/mcp";

type Execute = (
	args: Record<string, unknown>,
	options: {
		toolCallId: string;
		messages: unknown[];
		abortSignal?: AbortSignal;
	},
) => Promise<unknown>;

type JsonRpc = {
	id?: number;
	method: string;
	params?: {
		protocolVersion?: string;
		arguments?: { mode?: ToolMode };
	};
};

/**
 * How the simulated server answers a `tools/call`, chosen by the call's
 * `mode` argument:
 * - `hang`: the request never answers until its own signal aborts.
 * - `hang-sse-primed`: the POST is answered with an event stream that sends
 *   a priming event with an id (so the SDK may resume it with a GET carrying
 *   `last-event-id`) and then hangs; the stream errors when the request's
 *   signal aborts, as a real fetch body does.
 * - `sse-primed-then-closed`: like `hang-sse-primed`, but the server then ends
 *   the stream normally, so the SDK resumes it with a GET carrying
 *   `last-event-id`; that resumed stream sends no event of its own.
 * - `gated-json` / `gated-sse`: the answer waits for `release()`, then comes
 *   as a JSON body or as an event stream.
 */
type ToolMode =
	| "hang"
	| "hang-sse-primed"
	| "sse-primed-then-closed"
	| "gated-json"
	| "gated-sse";

function resultFor(message: JsonRpc): unknown {
	if (message.method === "initialize") {
		return {
			protocolVersion: message.params?.protocolVersion,
			capabilities: { tools: {} },
			serverInfo: { name: "example", version: "1.0.0" },
		};
	}
	if (message.method === "tools/list") {
		return {
			tools: [
				{
					name: "create_item",
					description: "Creates an item",
					inputSchema: { type: "object", properties: {} },
				},
			],
		};
	}
	return {};
}

/**
 * What the simulated server saw of its `tools/call` requests: the signal of
 * each one, resolved when that signal aborts.
 */
type ToolCallProbe = {
	signals: AbortSignal[];
	byMode: Map<ToolMode, AbortSignal>;
	received: Promise<AbortSignal>;
};

/** Settles with "aborted" when `signal` aborts, else "still running" after a while. */
function abortedWithin(signal: AbortSignal, ms = 500): Promise<string> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve("aborted");
			return;
		}
		const timer = setTimeout(() => resolve("still running"), ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve("aborted");
			},
			{ once: true },
		);
	});
}

/** A request that only ends when its own signal aborts. */
function hangUntilAborted(signal: AbortSignal | null | undefined) {
	return new Promise<Response>((_, reject) => {
		if (!signal) {
			return;
		}
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		signal.addEventListener("abort", () => reject(signal.reason), {
			once: true,
		});
	});
}

function probe(): ToolCallProbe & {
	record: (s: AbortSignal, mode?: ToolMode) => void;
} {
	let notify: (s: AbortSignal) => void = () => {};
	const received = new Promise<AbortSignal>((resolve) => {
		notify = resolve;
	});
	const signals: AbortSignal[] = [];
	const byMode = new Map<ToolMode, AbortSignal>();
	return {
		signals,
		byMode,
		received,
		record: (signal, mode = "hang") => {
			signals.push(signal);
			byMode.set(mode, signal);
			notify(signal);
		},
	};
}

const encoder = new TextEncoder();

/** An event-stream body that errors when `signal` aborts, as a fetch body does. */
function eventStream(
	signal: AbortSignal | null | undefined,
	events: string[],
	close = false,
): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const event of events) {
				controller.enqueue(encoder.encode(event));
			}
			if (close) {
				controller.close();
				return;
			}
			signal?.addEventListener(
				"abort",
				() => {
					try {
						controller.error(signal.reason);
					} catch {}
				},
				{ once: true },
			);
		},
	});
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function toolResult(id: number, mode: ToolMode) {
	return {
		jsonrpc: "2.0",
		id,
		result: { content: [{ type: "text", text: `done-${mode}` }] },
	};
}

/**
 * A Streamable HTTP server whose `tools/call` answers as its `mode` says.
 * A GET carrying `last-event-id` (a resumption of a POST's response stream)
 * is recorded in `resumptions`; any other GET is the standalone event
 * stream, offered when `eventStream` is set and refused with 405 otherwise.
 */
function httpServer(
	options: { unauthorizedOnce?: boolean; eventStream?: boolean } = {},
) {
	const toolCalls = probe();
	const getSignals: (AbortSignal | null | undefined)[] = [];
	const resumptions: string[] = [];
	const resumptionSignals: (AbortSignal | null | undefined)[] = [];
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let sentUnauthorized = false;
	const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
		const method = (init?.method ?? "GET").toUpperCase();
		if (method === "GET") {
			const lastEventId = new Headers(init?.headers).get("last-event-id");
			if (lastEventId) {
				resumptions.push(lastEventId);
				resumptionSignals.push(init?.signal);
				return eventStream(init?.signal, []);
			}
			getSignals.push(init?.signal);
			return options.eventStream
				? eventStream(init?.signal, [": open\n\n"])
				: new Response(null, { status: 405 });
		}
		const message = JSON.parse(String(init?.body)) as JsonRpc;
		if (message.id === undefined) {
			return new Response(null, { status: 202 });
		}
		if (message.method === "tools/call") {
			if (options.unauthorizedOnce && !sentUnauthorized) {
				sentUnauthorized = true;
				return new Response("unauthorized", { status: 401 });
			}
			const mode = message.params?.arguments?.mode ?? "hang";
			if (init?.signal) {
				toolCalls.record(init.signal, mode);
			}
			if (mode === "hang") {
				return hangUntilAborted(init?.signal);
			}
			if (mode === "sse-primed-then-closed") {
				return eventStream(
					init?.signal,
					["id: event-1\nretry: 10\ndata:\n\n"],
					true,
				);
			}
			if (mode === "hang-sse-primed") {
				return eventStream(init?.signal, [
					"id: event-1\nretry: 10\ndata:\n\n",
				]);
			}
			await Promise.race([gate, hangUntilAborted(init?.signal)]);
			const result = toolResult(message.id, mode);
			return mode === "gated-sse"
				? eventStream(
						init?.signal,
						[
							`id: event-2\nevent: message\ndata: ${JSON.stringify(result)}\n\n`,
						],
						true,
					)
				: Response.json(result);
		}
		return new Response(
			JSON.stringify({
				jsonrpc: "2.0",
				id: message.id,
				result: resultFor(message),
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	});
	return {
		fetch,
		toolCalls,
		getSignals,
		resumptions,
		resumptionSignals,
		release,
	};
}

/**
 * An SSE server: the GET opens the event stream, which names the POST
 * endpoint and carries every response; a POST is acknowledged with 202,
 * except `tools/call`, which hangs.
 */
function sseServer() {
	const toolCalls = probe();
	const getSignals: (AbortSignal | null | undefined)[] = [];
	let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
	const push = (event: string, data: string) =>
		stream?.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
	const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
		const method = (init?.method ?? "GET").toUpperCase();
		if (method === "GET") {
			getSignals.push(init?.signal);
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					stream = controller;
					push("endpoint", "/messages");
				},
			});
			init?.signal?.addEventListener("abort", () => {
				try {
					stream?.close();
				} catch {}
			});
			return new Response(body, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}
		const message = JSON.parse(String(init?.body)) as JsonRpc;
		if (message.method === "tools/call") {
			if (init?.signal) {
				toolCalls.record(init.signal);
			}
			return hangUntilAborted(init?.signal);
		}
		if (message.id !== undefined) {
			push(
				"message",
				JSON.stringify({
					jsonrpc: "2.0",
					id: message.id,
					result: resultFor(message),
				}),
			);
		}
		return new Response(null, { status: 202 });
	});
	return { fetch, toolCalls, getSignals };
}

/** A Fabric-refreshing OAuth provider holding a fixed token. */
function refreshingProvider() {
	const provider = {
		redirectUrl: "https://app.example.com/callback",
		clientMetadata: { redirect_uris: ["https://app.example.com/callback"] },
		clientInformation: () => ({ client_id: "example-client" }),
		tokens: () => ({ access_token: "access-1", token_type: "Bearer" }),
		saveTokens: () => undefined,
		redirectToAuthorization: () => undefined,
		saveCodeVerifier: () => undefined,
		codeVerifier: () => "verifier",
		refreshAfterUnauthorized: vi.fn(async () => "access-2"),
	};
	return provider as unknown as OAuthClientProvider & {
		refreshAfterUnauthorized: typeof provider.refreshAfterUnauthorized;
	};
}

let client: McpClientType | undefined;
afterEach(async () => {
	await client?.close().catch(() => {});
	client = undefined;
});

async function connectTools(
	server: { fetch: GitLabMcpFetch },
	transport: "HTTP" | "SSE",
	authProvider?: OAuthClientProvider,
) {
	client = await createMcpClient({
		serverUrl: SERVER,
		transport,
		fetch: server.fetch,
		authProvider,
	});
	return (await client.tools()) as unknown as Record<
		string,
		{ execute: Execute }
	>;
}

async function callAndAbort(
	server: { fetch: GitLabMcpFetch; toolCalls: ToolCallProbe },
	transport: "HTTP" | "SSE",
	authProvider?: OAuthClientProvider,
) {
	const tools = await connectTools(server, transport, authProvider);
	const call = new AbortController();
	const outcome = tools.create_item
		.execute(
			{},
			{ toolCallId: "c1", messages: [], abortSignal: call.signal },
		)
		.then(
			() => "resolved",
			() => "rejected",
		);
	const requestSignal = await server.toolCalls.received;
	expect(requestSignal.aborted).toBe(false);
	call.abort(new Error("the call timed out"));
	return { requestSignal, outcome };
}

describe("aborting an MCP tool call aborts its request", () => {
	it("over Streamable HTTP", async () => {
		const server = httpServer();
		const { requestSignal, outcome } = await callAndAbort(server, "HTTP");
		expect(await abortedWithin(requestSignal)).toBe("aborted");
		expect(await outcome).toBe("rejected");
	});

	it("over SSE", async () => {
		const server = sseServer();
		const { requestSignal, outcome } = await callAndAbort(server, "SSE");
		expect(await abortedWithin(requestSignal)).toBe("aborted");
		expect(await outcome).toBe("rejected");
	});

	it("including the resend after Fabric's refresh on a 401", async () => {
		const server = httpServer({ unauthorizedOnce: true });
		const provider = refreshingProvider();
		const { requestSignal, outcome } = await callAndAbort(
			server,
			"HTTP",
			provider,
		);
		expect(provider.refreshAfterUnauthorized).toHaveBeenCalledTimes(1);
		expect(await abortedWithin(requestSignal)).toBe("aborted");
		expect(await outcome).toBe("rejected");
	});

	it("but leaves the event stream (GET) running", async () => {
		const server = sseServer();
		const { requestSignal } = await callAndAbort(server, "SSE");
		expect(await abortedWithin(requestSignal)).toBe("aborted");
		expect(server.getSignals.length).toBeGreaterThan(0);
		for (const signal of server.getSignals) {
			expect(signal?.aborted ?? false).toBe(false);
		}
	});

	it.each(["gated-json", "gated-sse"] as const)(
		"and leaves a sibling call on the same cached client to finish (%s answer)",
		async (mode) => {
			const server = httpServer();
			const tools = await connectTools(server, "HTTP");
			const first = new AbortController();
			const aborted = tools.create_item
				.execute(
					{ mode: "hang" },
					{
						toolCallId: "c1",
						messages: [],
						abortSignal: first.signal,
					},
				)
				.then(
					() => "resolved",
					() => "rejected",
				);
			const sibling = tools.create_item.execute(
				{ mode },
				{
					toolCallId: "c2",
					messages: [],
					abortSignal: new AbortController().signal,
				},
			);
			await vi.waitFor(() =>
				expect(server.toolCalls.signals).toHaveLength(2),
			);
			first.abort(new Error("the call timed out"));
			expect(await aborted).toBe("rejected");
			expect(server.toolCalls.byMode.get("hang")?.aborted).toBe(true);
			expect(server.toolCalls.byMode.get(mode)?.aborted).toBe(false);
			server.release();
			await expect(sibling).resolves.toMatchObject({
				content: [{ type: "text", text: `done-${mode}` }],
			});
		},
	);

	it("and opens no request for the aborted call from a resumed stream that dies before sending an id", async () => {
		const server = httpServer({ eventStream: true });
		const tools = await connectTools(server, "HTTP");
		const call = new AbortController();
		const outcome = tools.create_item
			.execute(
				{ mode: "sse-primed-then-closed" },
				{ toolCallId: "c1", messages: [], abortSignal: call.signal },
			)
			.then(
				() => "resolved",
				() => "rejected",
			);
		// POST stream (event id) ends -> SDK resumes with GET + last-event-id,
		// whose stream sends nothing.
		await vi.waitFor(() => expect(server.resumptions).toHaveLength(1));
		const getsAtAbort = server.getSignals.length;
		call.abort(new Error("the call timed out"));
		expect(await outcome).toBe("rejected");
		// The resumption that was open when the call aborted is torn down with
		// it: left unbound it would hang open and never schedule another GET,
		// so the count assertions below could not see it.
		expect(server.resumptionSignals[0]?.aborted).toBe(true);
		// The resumed stream's reader errors and the SDK schedules another GET
		// (10 ms retry) without a last-event-id; it must not reach the server.
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(server.getSignals).toHaveLength(getsAtAbort);
		expect(server.resumptions).toHaveLength(1);
		expect(server.getSignals.length).toBeGreaterThan(0);
		for (const signal of server.getSignals) {
			expect(signal?.aborted ?? false).toBe(false);
		}
		server.release();
		await expect(
			tools.create_item.execute(
				{ mode: "gated-sse" },
				{ toolCallId: "c2", messages: [] },
			),
		).resolves.toMatchObject({
			content: [{ type: "text", text: "done-gated-sse" }],
		});
	});

	it("and never resumes the aborted call's streamed response, leaving the client usable", async () => {
		const server = httpServer({ eventStream: true });
		const tools = await connectTools(server, "HTTP");
		const call = new AbortController();
		const outcome = tools.create_item
			.execute(
				{ mode: "hang-sse-primed" },
				{ toolCallId: "c1", messages: [], abortSignal: call.signal },
			)
			.then(
				() => "resolved",
				() => "rejected",
			);
		const requestSignal = await server.toolCalls.received;
		// Let the client read the priming event (and its id) first.
		await new Promise((resolve) => setTimeout(resolve, 20));
		call.abort(new Error("the call timed out"));
		expect(await abortedWithin(requestSignal)).toBe("aborted");
		expect(await outcome).toBe("rejected");
		// The server asked for a 10 ms retry; the SDK tries twice.
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(server.resumptions).toEqual([]);
		// The shared event stream is untouched and later calls still work.
		expect(server.getSignals.length).toBeGreaterThan(0);
		for (const signal of server.getSignals) {
			expect(signal?.aborted ?? false).toBe(false);
		}
		server.release();
		await expect(
			tools.create_item.execute(
				{ mode: "gated-sse" },
				{ toolCallId: "c2", messages: [] },
			),
		).resolves.toMatchObject({
			content: [{ type: "text", text: "done-gated-sse" }],
		});
	});
});

describe("abortWritesWithCallSignal outside a call", () => {
	it("is the given fetch, signal untouched", async () => {
		const base = vi.fn(async () => new Response("ok"));
		const own = new AbortController();
		await abortWritesWithCallSignal(base)(SERVER, {
			method: "POST",
			signal: own.signal,
		});
		expect(base).toHaveBeenCalledWith(SERVER, {
			method: "POST",
			signal: own.signal,
		});
	});
});

describe("withCallSignalScope and abortWritesWithCallSignal together", () => {
	function scopedTransport(onSend: (message: unknown) => Promise<void>) {
		const inner = {
			start: vi.fn(async () => undefined),
			close: vi.fn(async () => undefined),
			send: vi.fn(onSend),
			onmessage: undefined as Transport["onmessage"],
			sessionId: "session-1",
		};
		return { inner, outer: withCallSignalScope<Transport>(inner) };
	}

	it("binds a POST and a GET sent in a call's send to that call, but not a token request", async () => {
		const base = vi.fn(
			async (_url: string | URL, _init?: RequestInit) =>
				new Response("ok"),
		);
		const guarded = abortWritesWithCallSignal(base);
		const call = new AbortController();
		const lastInit = () => base.mock.calls.at(-1)?.[1];
		const seen: Record<string, RequestInit | undefined> = {};
		const { outer } = scopedTransport(async () => {
			// After an await of the transport's own, as before a real send.
			await Promise.resolve();
			await guarded(SERVER, { method: "GET" });
			seen.GET = lastInit();
			await guarded(SERVER, {
				method: "POST",
				body: new URLSearchParams({ grant_type: "refresh_token" }),
			});
			seen.token = lastInit();
			await guarded(SERVER, { method: "POST", body: "{}" });
			seen.POST = lastInit();
		});
		await outer.send({ jsonrpc: "2.0", method: "ping", id: 1 }, {
			signal: call.signal,
		} as never);
		expect(seen.token?.signal).toBeUndefined();
		expect(seen.GET?.signal?.aborted).toBe(false);
		call.abort();
		expect(seen.POST?.signal?.aborted).toBe(true);
		expect(seen.GET?.signal?.aborted).toBe(true);
	});

	it("refuses a POST whose call was already aborted, without sending it", async () => {
		const base = vi.fn(async () => new Response("ok"));
		const guarded = abortWritesWithCallSignal(base);
		const call = new AbortController();
		call.abort(new Error("timed out"));
		const { outer } = scopedTransport(async () => {
			await guarded(SERVER, { method: "POST", body: "{}" });
		});
		await expect(
			outer.send({ jsonrpc: "2.0", method: "ping", id: 1 }, {
				signal: call.signal,
			} as never),
		).rejects.toThrow("timed out");
		expect(base).not.toHaveBeenCalled();
	});

	it("does not bind a send without a signal, even inside another call's scope", async () => {
		const base = vi.fn(async () => new Response("ok"));
		const guarded = abortWritesWithCallSignal(base);
		const call = new AbortController();
		call.abort();
		const reply = scopedTransport(async () => {
			await guarded(SERVER, { method: "POST", body: "{}" });
		});
		const { outer } = scopedTransport(async () => {
			await reply.outer.send({ jsonrpc: "2.0", id: 9, result: {} });
		});
		await outer.send({ jsonrpc: "2.0", method: "ping", id: 1 }, {
			signal: call.signal,
		} as never);
		expect(base).toHaveBeenCalledWith(SERVER, {
			method: "POST",
			body: "{}",
		});
	});

	it("binds a GET resuming the call's response stream (last-event-id) and refuses one scheduled after the call aborted, with or without last-event-id", async () => {
		const base = vi.fn(
			async (_url: string | URL, _init?: RequestInit) =>
				new Response("ok"),
		);
		const guarded = abortWritesWithCallSignal(base);
		const call = new AbortController();
		const resume = (withId = true) =>
			guarded(SERVER, {
				method: "GET",
				headers: withId
					? new Headers({ "last-event-id": "event-1" })
					: undefined,
			});
		let later: Promise<string> = Promise.resolve("never scheduled");
		let fire: () => void = () => {};
		const fired = new Promise<void>((resolve) => {
			fire = resolve;
		});
		const { outer } = scopedTransport(async () => {
			await resume();
			// As the SDK's reconnection does: a timer started from the
			// call's work, which keeps its scope.
			later = new Promise((resolve) => {
				void fired.then(() =>
					setTimeout(() => {
						// With and without last-event-id: the reconnect after a
						// resumed stream that sent no id carries none.
						Promise.all([resume(true), resume(false)]).then(
							() => resolve("sent"),
							() => resolve("refused"),
						);
					}, 0),
				);
			});
		});
		await outer.send({ jsonrpc: "2.0", method: "tools/call", id: 1 }, {
			signal: call.signal,
		} as never);
		expect(base.mock.calls[0]?.[1]?.signal).toBe(call.signal);
		call.abort(new Error("timed out"));
		fire();
		expect(await later).toBe("refused");
		expect(base).toHaveBeenCalledTimes(1);
	});

	it("gives a notification no call scope, even when sent with a signal", async () => {
		const base = vi.fn(
			async (_url: string | URL, _init?: RequestInit) =>
				new Response("ok"),
		);
		const guarded = abortWritesWithCallSignal(base);
		const connection = new AbortController();
		connection.abort();
		const { outer } = scopedTransport(async () => {
			// What the Streamable HTTP transport does on the 202 to
			// `notifications/initialized`: open the shared event stream, and
			// later resume it with `last-event-id`.
			await guarded(SERVER, { method: "GET" });
			await guarded(SERVER, {
				method: "GET",
				headers: new Headers({ "last-event-id": "event-9" }),
			});
		});
		await outer.send(
			{ jsonrpc: "2.0", method: "notifications/initialized" },
			{ signal: connection.signal } as never,
		);
		expect(base).toHaveBeenCalledTimes(2);
		for (const [, init] of base.mock.calls) {
			expect(init?.signal).toBeUndefined();
		}
	});

	it("reads and writes everything but send through to the inner transport", async () => {
		const { inner, outer } = scopedTransport(async () => undefined);
		const onmessage = () => undefined;
		outer.onmessage = onmessage as never;
		expect(inner.onmessage).toBe(onmessage);
		expect(outer.sessionId).toBe("session-1");
		expect("start" in outer && "close" in outer).toBe(true);
		await outer.start();
		await outer.close();
		expect(inner.start).toHaveBeenCalledTimes(1);
		expect(inner.close).toHaveBeenCalledTimes(1);
		const options = { relatedRequestId: 3 };
		await outer.send({ jsonrpc: "2.0", method: "ping", id: 1 }, options);
		expect(inner.send).toHaveBeenCalledWith(
			{ jsonrpc: "2.0", method: "ping", id: 1 },
			options,
		);
	});
});
