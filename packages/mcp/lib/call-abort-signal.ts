/**
 * Carries the abort signal of the MCP call being sent down to the `fetch`
 * that sends it, so aborting a tool call (Fabric's tool timeout, a stopped
 * chat turn) tears down its HTTP request instead of only no longer waiting
 * for the answer (Fizzy #3071).
 *
 * `@ai-sdk/mcp` hands the call's signal to `transport.send(message,
 * { signal })`, but the `@modelcontextprotocol/sdk` HTTP and SSE transports
 * (1.32.1) ignore it: they post with their own connection-wide abort
 * controller. The transport's `fetch` is fixed when the client is built and
 * the client is cached and shared between calls, so the signal cannot be
 * given to the fetch up front either. Instead `withCallSignalScope` wraps the
 * transport so each `send` of a JSON-RPC request runs in an AsyncLocalStorage
 * scope holding that call's signal, and `abortWritesWithCallSignal` — the
 * transport's outermost `fetch` layer — binds every request made in that scope
 * (except OAuth token requests) to the signal. Ownership is by scope: whatever
 * runs inside a call's scope serves that call. The shared event stream stays
 * unbound because it never opens inside a scope (see `withCallSignalScope`).
 *
 * Uses globalThis to keep a single AsyncLocalStorage instance even when the
 * bundler creates several copies of this module, as `dispatch-deadline` does.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type {
	Transport,
	TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type { GitLabMcpFetch } from "./gitlab-credential";

const STORAGE_KEY = "__fabric_mcp_call_abort_signal_storage__" as const;

const globals = globalThis as Record<string, unknown>;

const callSignalStorage: AsyncLocalStorage<{ signal: AbortSignal }> =
	(globals[STORAGE_KEY] as
		| AsyncLocalStorage<{ signal: AbortSignal }>
		| undefined) ??
	(() => {
		const storage = new AsyncLocalStorage<{ signal: AbortSignal }>();
		globals[STORAGE_KEY] = storage;
		return storage;
	})();

/** The abort signal of the MCP call the code running now is sending, if any. */
function currentMcpCallSignal(): AbortSignal | undefined {
	return callSignalStorage.getStore()?.signal;
}

/**
 * Whether `message` is a JSON-RPC request (a `method` and an `id`), or a
 * batch holding one: the only message that has a call of its own waiting on
 * an answer. A notification has no `id`; a response has no `method`.
 */
function isJsonRpcRequest(message: unknown): boolean {
	const messages = Array.isArray(message) ? message : [message];
	return messages.some(
		(entry) =>
			typeof entry === "object" &&
			entry !== null &&
			"method" in entry &&
			"id" in entry &&
			(entry as { id?: unknown }).id !== undefined,
	);
}

/**
 * Wraps an MCP SDK transport so each `send` of a JSON-RPC request runs with
 * the call's abort signal (`options.signal`, which `@ai-sdk/mcp` passes and
 * the SDK transports ignore) as the ambient call signal, for
 * `abortWritesWithCallSignal` to read. The scope reaches everything the
 * transport starts for that request, timers included: its POST, the 401
 * resend, and a resumption of its response stream.
 *
 * Every other `send` runs with no call signal at all, even when it is given
 * one or runs inside another call's work:
 * - a notification, because the Streamable HTTP transport opens the shared
 *   event stream (GET) from inside the send of `notifications/initialized`,
 *   which `@ai-sdk/mcp` sends with the connection's own signal; in a scope,
 *   that stream and its reconnects would belong to one call;
 * - a response (a reply to a server request read off a call's response
 *   stream), which answers the server, not the call.
 *
 * Holding to this, everything that runs in a call scope serves that call,
 * which is what lets `abortWritesWithCallSignal` bind all of it.
 *
 * Everything else — `start`, `close`, `setProtocolVersion`, the
 * `onmessage`/`onerror`/`onclose` callbacks the client assigns, `sessionId`
 * — is the inner transport's own, read and written through to it, and the
 * options reach the inner `send` unchanged.
 */
export function withCallSignalScope<T extends Transport>(transport: T): T {
	const send = (
		message: Parameters<Transport["send"]>[0],
		options?: TransportSendOptions,
	): Promise<void> => {
		const signal = (options as { signal?: unknown } | undefined)?.signal;
		const run = () => transport.send(message, options);
		return signal instanceof AbortSignal && isJsonRpcRequest(message)
			? callSignalStorage.run({ signal }, run)
			: callSignalStorage.exit(run);
	};
	return new Proxy(transport, {
		get(target, property) {
			if (property === "send") {
				return send;
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
		set(target, property, value) {
			return Reflect.set(target, property, value, target);
		},
	});
}

/**
 * Binds every request made inside a call scope (`withCallSignalScope`) to that
 * call's abort signal, alongside the transport's own signal, and refuses to
 * send one whose call was already aborted. Aborting the call then aborts its
 * requests: an unsent request is not sent, one in flight has its connection
 * torn down, and its response stream is cancelled. Bytes the server already
 * received cannot be recalled, so a server that has started handling the call
 * may still finish it.
 *
 * The rule is ownership by scope, not by request fields: anything that runs
 * in a call scope serves that call, whatever its method or headers. That
 * covers the call's JSON-RPC POST, the 401 resend, the resumption of its
 * response stream (GET with `last-event-id`), a reconnect the SDK schedules
 * after that resumed stream breaks (a GET with no `last-event-id`, because the
 * resumed stream had sent no event id yet), and OAuth metadata discovery run
 * for the call (a read; cutting it off is harmless).
 *
 * What keeps the shared event stream out of this: `withCallSignalScope` opens
 * a scope only for a JSON-RPC request, so the Streamable HTTP transport's
 * standalone GET, opened from inside the send of `notifications/initialized`,
 * runs unscoped, as do its reconnects. If a transport ever opened that stream
 * from inside a request's send, it would be bound to that call.
 *
 * Exempt: an OAuth token request (a `URLSearchParams` body) is never cut off,
 * since aborting it after the server acted on it would lose a rotated refresh
 * token or a spent authorization code. Reply POSTs to server-initiated
 * requests (elicitation, sampling) are responses, which run unscoped, so they
 * are deliberately outside this mechanism. Outside a call scope this is the
 * given `fetch` unchanged.
 *
 * A refused request throws into the SDK, which reports it through `onerror`
 * and, for a reconnection, gives up after its retry limit; the transport and
 * its other calls carry on.
 */
export function abortWritesWithCallSignal(
	baseFetch: GitLabMcpFetch,
): GitLabMcpFetch {
	return async (input, init) => {
		const callSignal = currentMcpCallSignal();
		if (!callSignal || init?.body instanceof URLSearchParams) {
			return baseFetch(input, init);
		}
		callSignal.throwIfAborted();
		const signal = init?.signal
			? AbortSignal.any([init.signal, callSignal])
			: callSignal;
		return baseFetch(input, { ...init, signal });
	};
}
