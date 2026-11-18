import { GRAPH_REQUEST_TIMEOUT_MS } from "./config/limits";

export class MicrosoftRequestTimeoutError extends Error {}

/** One fresh deadline per HTTP attempt, preserving the caller's cancellation. */
export async function microsoftFetch(
	url: string,
	options: RequestInit = {},
	{
		timeoutMs = GRAPH_REQUEST_TIMEOUT_MS,
		fetchImpl = fetch,
	}: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<Response> {
	const timeout = AbortSignal.timeout(timeoutMs);
	const signal = options.signal
		? AbortSignal.any([options.signal, timeout])
		: timeout;
	try {
		return await fetchImpl(url, { ...options, signal });
	} catch (error) {
		if (
			signal.aborted &&
			signal.reason === timeout.reason &&
			timeout.aborted
		) {
			const service =
				new URL(url).hostname === "login.microsoftonline.com"
					? "Microsoft identity"
					: "Microsoft Graph";
			throw new MicrosoftRequestTimeoutError(
				`${service} request timed out: ${(options.method ?? "GET").toUpperCase()} ${new URL(url).pathname}`,
			);
		}
		throw error;
	}
}
