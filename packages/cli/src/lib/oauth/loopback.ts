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
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

interface CallbackResult {
	code: string;
}

export interface LoopbackListener {
	redirectUri: string;
	/** Resolves with the code, or rejects on denial, timeout or abort. */
	result: Promise<CallbackResult>;
	close: () => void;
}

const PAGE = (title: string, body: string): string =>
	`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1 style="font-weight:400">${title}</h1><p>${body}</p></body>`;

export async function startLoopbackListener(options: {
	state: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}): Promise<LoopbackListener> {
	let settle: (outcome: { code: string } | { error: Error }) => void =
		() => {};
	const result = new Promise<CallbackResult>((resolve, reject) => {
		settle = (outcome) => {
			if ("code" in outcome) {
				resolve({ code: outcome.code });
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
		if (request.method !== "GET" || url.pathname !== CALLBACK_PATH) {
			response.writeHead(404).end();
			return;
		}

		const error = url.searchParams.get("error");
		const state = url.searchParams.get("state");
		const code = url.searchParams.get("code");

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
			response
				.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
				.end(
					PAGE(
						"Sign-in cancelled",
						"You can close this tab and return to your terminal.",
					),
				);
			settle({
				error: new Error(
					error === "access_denied"
						? "Sign-in was denied in the browser."
						: `Sign-in failed (${error}).`,
				),
			});
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

		response
			.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
			.end(
				PAGE(
					"Signed in",
					"You can close this tab and return to your terminal.",
				),
			);
		settle({ code });
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});

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
		redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
		result,
		close,
	};
}
