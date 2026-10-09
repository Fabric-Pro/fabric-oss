/**
 * The loopback listener an authorization code comes back to (RFC 8252 section
 * 7.3).
 *
 * Bound to 127.0.0.1 only and to an ephemeral port, and it answers exactly one
 * path. A callback is accepted only when its `state` matches the one this login
 * started; anything else is answered with an error page and does not end the
 * wait, so a stray or hostile request cannot cancel a login in progress.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const CALLBACK_PATH = "/callback";
/**
 * How long the browser is waited for when the caller does not say. Finite on
 * purpose: `init` runs this for an agent that has no terminal, and a run
 * nobody is watching has to end.
 */
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

interface CallbackResult {
	code: string;
	/** Every query parameter of the accepted callback. */
	params: URLSearchParams;
}

/** The authorization server sent the browser back with an `error`. */
export class CallbackError extends Error {
	constructor(
		readonly error: string,
		readonly description: string | null,
	) {
		super(
			error === "access_denied"
				? "Sign-in was denied in the browser."
				: `Sign-in failed (${error}).`,
		);
		this.name = "CallbackError";
	}
}

export interface LoopbackListener {
	redirectUri: string;
	/** Resolves with the code, or rejects on denial, timeout or abort. */
	result: Promise<CallbackResult>;
	close: () => void;
}

// The last page of a sign-in: the listener closes right after it, so the
// browser is told not to keep the connection for another request.
const FINAL_PAGE_HEADERS = {
	"Content-Type": "text/html; charset=utf-8",
	Connection: "close",
};

const PAGE = (title: string, body: string): string =>
	`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1 style="font-weight:400">${title}</h1><p>${body}</p></body>`;

export async function startLoopbackListener(options: {
	state: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	/** The callback path; `/callback` unless the authorization server fixes one. */
	callbackPath?: string;
	/**
	 * A port to try first, for a server that registers it; an ephemeral port
	 * is used when it is taken.
	 */
	preferredPort?: number;
	/** The query parameter carrying the grant; `code` unless the sender names another. */
	codeParam?: string;
}): Promise<LoopbackListener> {
	const callbackPath = options.callbackPath ?? CALLBACK_PATH;
	let settle: (outcome: CallbackResult | { error: Error }) => void = () => {};
	const result = new Promise<CallbackResult>((resolve, reject) => {
		settle = (outcome) => {
			if ("code" in outcome) {
				resolve(outcome);
			} else {
				reject(outcome.error);
			}
		};
	});
	// An unobserved rejection would crash the process when the listener is
	// closed before anyone awaits it.
	result.catch(() => {});

	const server: Server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (request.method !== "GET" || url.pathname !== callbackPath) {
			response.writeHead(404).end();
			return;
		}

		const error = url.searchParams.get("error");
		const state = url.searchParams.get("state");
		const code = url.searchParams.get(options.codeParam ?? "code");

		if (state !== options.state) {
			response
				.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
				.end(
					PAGE(
						"Sign-in failed",
						"This request does not belong to the sign-in in progress.",
					),
				);
			return;
		}

		if (error) {
			const failure = new CallbackError(
				error,
				url.searchParams.get("error_description"),
			);
			// Settled only once the page is written: whoever awaits the result
			// closes the listener, which would otherwise cut the reply off.
			response
				.writeHead(200, FINAL_PAGE_HEADERS)
				.end(
					PAGE(
						"Sign-in cancelled",
						"You can close this tab and return to your terminal.",
					),
					() => settle({ error: failure }),
				);
			return;
		}

		if (!code) {
			response
				.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
				.end(
					PAGE(
						"Sign-in failed",
						"The response carried no authorization code.",
					),
				);
			return;
		}

		// As above: the browser gets the whole page before anyone can close.
		response
			.writeHead(200, FINAL_PAGE_HEADERS)
			.end(
				PAGE(
					"Signed in",
					"You can close this tab and return to your terminal.",
				),
				() => settle({ code, params: url.searchParams }),
			);
	});

	const listen = (port: number) =>
		new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(port, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});
	if (options.preferredPort === undefined) {
		await listen(0);
	} else {
		await listen(options.preferredPort).catch(() => listen(0));
	}

	const { port } = server.address() as AddressInfo;
	const timer = setTimeout(
		() =>
			settle({
				error: new Error("Timed out waiting for the browser sign-in."),
			}),
		options.timeoutMs ?? LOGIN_TIMEOUT_MS,
	);
	const onAbort = () =>
		settle({ error: new Error("Sign-in was cancelled.") });
	options.signal?.addEventListener("abort", onAbort, { once: true });

	const close = () => {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
		server.closeAllConnections();
		server.close();
	};
	result.then(close, close);

	return {
		redirectUri: `http://127.0.0.1:${port}${callbackPath}`,
		result,
		close,
	};
}
