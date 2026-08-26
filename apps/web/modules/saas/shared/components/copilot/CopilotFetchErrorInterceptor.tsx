"use client";

import { useActiveOrganization } from "@saas/organizations/hooks/use-active-organization";
import {
	isAiUsageLimitExceededPayload,
	useShowAiUsageLimitToast,
} from "@saas/payments/lib/ai-usage-limit-toast";
import {
	AI_NETWORK_FAILURE,
	AI_STREAM_RESUMED,
	AI_STREAM_SILENT,
	describeAiError,
	describeAiStreamError,
} from "@saas/shared/lib/ai-error-message";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { findAgUiRunError } from "./ag-ui-run-error";
import {
	type AiErrorToastAction,
	dismissAiErrorToast,
	resolveAiErrorToast,
	showPersistentAiErrorToast,
	showTransientAiErrorToast,
} from "./copilot-error-toast";

/**
 * Intercepts fetch responses to /api/copilotkit and shows toast notifications
 * for HTTP errors (429 rate limit, 5xx server errors, etc.).
 * CopilotKit v1's `onError` prop requires a `publicApiKey`/`publicLicenseKey`
 * which means self-hosted setups with no key get silent failures. This component
 * patches `window.fetch` to detect those failures and surface them to the user.
 * Place this component once, anywhere in the React tree (ideally in a layout
 * or near the root). It does NOT need to be inside a `<CopilotKit>` provider.
 *
 * Toast behaviour (persist-until-dismissed vs transient countdown), dedup, and
 * stable-id stacking prevention live in the shared `copilot-error-toast` helper
 * so this path and CopilotKit's `onError` path (`useCopilotErrorHandler`) stay
 * in lockstep.
 */
/**
 * Fired when a chat request is refused for being too large (HTTP 413), so the
 * surface holding the attachments can drop them and leave the thread usable.
 *
 * The failure is detected here, in a module-level `window.fetch` patch, but only
 * the owning component can act on it — hence an event. Carries no detail: the
 * body is over budget as a whole, and which entry to blame is the listener's
 * call, not this one's.
 */
export const AI_REQUEST_TOO_LARGE_EVENT = "fabric:ai-request-too-large";

/** Max backoff in seconds for consecutive 429s */
const MAX_BACKOFF_SECONDS = 60;

/**
 * AI calls that must NOT raise a toast, and why. Broad interception is the
 * point of this module — a failure the user is waiting on should never be
 * silent — but three kinds of request are not that:
 *
 *   - **Fire-and-forget cancel/stop.** Nothing the user can act on, and the run
 *     they were watching reports its own outcome.
 *   - **Ambient background work.** `suggest-tools` enriches the composer and
 *     fails quietly by design (`useToolSuggestions` keeps the error in local
 *     state and renders nothing). A persistent toast for a failed *suggestion*
 *     is pure noise the user cannot act on.
 *   - **Calls whose caller already owns the error UI.** `upload-image` is
 *     awaited by chat components that catch and toast "Failed to upload <name>"
 *     themselves; toasting here too shows the same failure twice.
 *
 * A denylist rather than an allowlist so a newly added user-facing transport is
 * covered by default — silence is the failure mode this module exists to
 * prevent. Each entry is asserted by a test, so removing an endpoint without
 * revisiting this list fails loudly.
 */
const SILENT_AI_CALL_PATTERNS: readonly RegExp[] = [
	/\/(?:cancel|stop)(?:\?|$)/,
	/\/suggest-tools(?:\?|$)/,
	/\/upload-image(?:\?|$)/,
];

function isSilentAiCall(url: string): boolean {
	return SILENT_AI_CALL_PATTERNS.some((pattern) => pattern.test(url));
}

/**
 * Surface a run that failed after its response had already succeeded.
 *
 * Consumes a clone in the background, so nothing here delays the response the
 * caller is waiting on. A stream that ends normally, or that carries no
 * `RUN_ERROR`, is silent — this only ever speaks when the run genuinely failed.
 *
 * A read that throws means the connection died part-way through a reply the
 * user was watching, which is the same silence wearing a different hat, so it
 * gets the same treatment as a network failure before the response. Aborts are
 * excluded exactly as they are on the request path above: navigating away or
 * replacing a request is intentional, and not something to report.
 */
function watchStreamForSilentFailure(
	response: Response,
	billingAction: AiErrorToastAction | undefined,
): void {
	// Raised when the run has sent nothing for long enough to look wedged, and
	// retracted the moment it speaks again — see `STREAM_SILENCE_MS`. Anything
	// more specific that arrives later supersedes it, so it is cleared before
	// those toasts rather than stacking two notices about one run.
	// Silent when something more specific is about to be shown: that toast is
	// itself an announcement, so the notice is replaced rather than narrated
	// twice.
	const clearStallNotice = () =>
		dismissAiErrorToast(
			AI_STREAM_SILENT.title,
			AI_STREAM_SILENT.description,
		);

	void findAgUiRunError(response, {
		onSilence: () =>
			showPersistentAiErrorToast(
				AI_STREAM_SILENT.title,
				AI_STREAM_SILENT.description,
			),
		// Resuming is the one case with nothing following it, so a bare dismiss
		// would leave a screen-reader user holding "the assistant has gone
		// quiet" as the last thing they were told — removals are not announced.
		onResume: () =>
			resolveAiErrorToast(
				AI_STREAM_SILENT.title,
				AI_STREAM_SILENT.description,
				AI_STREAM_RESUMED,
			),
	})
		.then((runError) => {
			if (!runError) {
				return;
			}
			clearStallNotice();
			const copy = describeAiStreamError(runError);
			showPersistentAiErrorToast(
				copy.title,
				copy.description,
				Date.now(),
				copy.billingActionable ? billingAction : undefined,
			);
		})
		.catch((error: unknown) => {
			if (error instanceof DOMException && error.name === "AbortError") {
				clearStallNotice();
				return;
			}
			clearStallNotice();
			showPersistentAiErrorToast(
				AI_NETWORK_FAILURE.title,
				AI_NETWORK_FAILURE.description,
			);
		});
}

export function CopilotFetchErrorInterceptor() {
	const patchedRef = useRef(false);
	const showAiUsageLimitToast = useShowAiUsageLimitToast();
	// The out-of-credit copy asks someone to top the account up; without a
	// destination that is only half a message. Routing needs the active
	// organization, which only exists in React — so it is resolved here and
	// handed to the module-level toast helpers, the same shape the usage-limit
	// callback below already uses. Mirrors `useLimitToast`: the button is shown
	// only to someone who can actually act on it.
	const { activeOrganization, isOrganizationAdmin } = useActiveOrganization();
	const router = useRouter();
	const billingActionRef = useRef<AiErrorToastAction | undefined>(undefined);
	useEffect(() => {
		const canManageBilling = activeOrganization
			? isOrganizationAdmin
			: true;
		if (!canManageBilling) {
			billingActionRef.current = undefined;
			return;
		}
		const href = activeOrganization?.slug
			? `/app/${activeOrganization.slug}/settings/billing`
			: "/app/settings/billing";
		billingActionRef.current = {
			label: "Billing settings",
			onClick: () => router.push(href),
		};
	}, [activeOrganization, isOrganizationAdmin, router]);
	// Captured in a ref because `useEffect` runs once and the fetch
	// wrapper closes over its surroundings; without this the toast
	// call inside the wrapper would forever invoke the original
	// (potentially stale) translator. The ref keeps the callback
	// fresh even after re-renders.
	const showAiUsageLimitToastRef = useRef(showAiUsageLimitToast);
	useEffect(() => {
		showAiUsageLimitToastRef.current = showAiUsageLimitToast;
	}, [showAiUsageLimitToast]);

	useEffect(() => {
		if (patchedRef.current) {
			return;
		}
		patchedRef.current = true;

		const originalFetch = window.fetch;

		// Client-side rate-limit backoff state
		let blockedUntil = 0;
		let consecutive429Count = 0;

		window.fetch = async function patchedFetch(
			input: RequestInfo | URL,
			init?: RequestInit,
		) {
			// Only intercept calls to our CopilotKit endpoint
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.href
						: input.url;

			// Toasting covers every AI endpoint, not just CopilotKit: the
			// assistant is reachable through several transports (the Nexus /
			// Loom direct stream, the Temporal orchestrator, the sidekick,
			// `/api/ai/generate`) and a failure on any of them used to be
			// silent. The CopilotKit-specific machinery below — the
			// client-side 429 backoff and the `agent/stop` bypass — stays
			// gated on `isCopilotKit`, because that state belongs to that
			// transport's per-thread run lock.
			//
			const isCopilotKit = url.includes("/api/copilotkit");
			const isAiEndpoint =
				isCopilotKit || /\/api\/(?:agents|ai)\//.test(url);
			if (!isAiEndpoint || isSilentAiCall(url)) {
				return originalFetch.call(this, input, init);
			}

			// CopilotKit's single-endpoint transport POSTs a JSON body naming
			// the RPC method (e.g. `{"method":"agent/stop",...}`). The
			// server-side InMemoryAgentRunner holds a per-thread `isRunning`
			// lock that only an `agent/stop` call or run completion clears —
			// if a stop request gets swallowed by our client-side backoff
			// below, the lock is never released and the next run on that
			// thread throws "Thread already running" (GH issue #2526). So a
			// stop request must always reach the server: bypass both the
			// backoff short-circuit and the error-handling branches below —
			// there's no user-facing toast worth showing for a fire-and-forget
			// stop call anyway.
			//
			// Detected via an anchored regex rather than `JSON.parse` — an
			// `agent/run` body can carry the full document state + message
			// history, and parsing that on every single request is wasted
			// work. CopilotKit 1.52 always serializes `method` as the first
			// key, so the regex only ever inspects a short prefix of the
			// body (O(prefix), not O(body)) and — unlike `JSON.parse` — can't
			// throw, so no try/catch is needed. This does not handle a
			// `Request`-object body (only a string `init.body`), but the
			// 1.52 client always calls `fetch(url, init)` with a stringified
			// body, so that's not a real gap for this transport.
			const isStopRequest =
				typeof init?.body === "string" &&
				/^\s*\{\s*"method"\s*:\s*"agent\/stop"\s*[,}]/.test(init.body);

			if (isCopilotKit && isStopRequest) {
				return originalFetch.call(this, input, init);
			}

			// Client-side backoff: block requests while rate-limited
			const now = Date.now();
			if (isCopilotKit && now < blockedUntil) {
				const remainingSeconds = Math.ceil((blockedUntil - now) / 1000);
				return new Response(
					JSON.stringify({
						error: "Rate limited (client-side backoff)",
						retryAfter: remainingSeconds,
					}),
					{
						status: 429,
						headers: {
							"Content-Type": "application/json",
							"Retry-After": remainingSeconds.toString(),
							"X-Rate-Limit-Source": "client-backoff",
						},
					},
				);
			}

			let response: Response;
			try {
				response = await originalFetch.call(this, input, init);
			} catch (error) {
				// Intentional aborts (navigation, retries, replaced requests) are not errors
				if (
					error instanceof DOMException &&
					error.name === "AbortError"
				) {
					throw error;
				}
				// Genuine network failure, offline, DNS resolution, etc.
				showPersistentAiErrorToast(
					AI_NETWORK_FAILURE.title,
					AI_NETWORK_FAILURE.description,
				);
				throw error;
			}

			if (response.ok) {
				// Reset backoff state on success
				consecutive429Count = 0;
				// A 200 is not proof the run succeeded. The AG-UI stream
				// commits its status line the moment it opens — before the
				// agent has run — so everything that fails after that point
				// reports itself *inside* the stream, as a `RUN_ERROR` frame on
				// a healthy response. That is the one shape this interceptor
				// used to hand back untouched, and with `onError` inert without
				// a CopilotKit license key it was the shape nothing caught at
				// all: the assistant just stopped answering.
				//
				// Watched on a clone, and deliberately not awaited, so the
				// response reaches CopilotKit at the same moment it always did.
				watchStreamForSilentFailure(response, billingActionRef.current);
				return response;
			}

			// Clone so CopilotKit can still read the response body
			const cloned = response.clone();

			// AI usage-limit short-circuit:
			// the server emits a structured `AI_USAGE_LIMIT_EXCEEDED`
			// envelope with `data: { limitId, dimension,.. }` from the
			// `/api/copilotkit` route's tenant-config catch when the
			// chokepoint blocks. Render the shared destructive toast and
			// return early so the generic 429 handler below ("AI service
			// is busy") doesn't double-fire and overwrite the rich copy.
			// Wrapped in its own try so a malformed body doesn't break the
			// downstream rate-limit / 5xx handlers.
			try {
				const peek = response.clone();
				if (
					peek.headers
						.get("content-type")
						?.includes("application/json")
				) {
					const body = (await peek.json()) as
						| {
								code?: string;
								data?: unknown;
						  }
						| undefined;
					if (body?.code === "AI_USAGE_LIMIT_EXCEEDED") {
						const payloadCandidate = isAiUsageLimitExceededPayload(
							body.data,
						)
							? body.data
							: isAiUsageLimitExceededPayload(body)
								? body
								: null;
						if (payloadCandidate) {
							showAiUsageLimitToastRef.current(payloadCandidate);
							// Reset backoff state — the AI-usage-limit
							// signal is orthogonal to provider rate
							// limiting and shouldn't trigger our 429
							// exponential-backoff window.
							consecutive429Count = 0;
							return response;
						}
					}
				}
			} catch {
				// Body read failed (already consumed, malformed JSON,..).
				// Fall through to the existing handlers — they will surface
				// a generic toast for the underlying status code.
			}

			if (isCopilotKit && response.status === 429) {
				// Exponential backoff: block future requests client-side
				consecutive429Count++;
				let backoffSeconds = Math.min(
					MAX_BACKOFF_SECONDS,
					2 ** consecutive429Count,
				);

				// Prefer server's Retry-After if available
				const retryAfterHeader = response.headers.get("Retry-After");
				if (retryAfterHeader) {
					const parsed = Number.parseInt(retryAfterHeader, 10);
					if (!Number.isNaN(parsed) && parsed > 0) {
						backoffSeconds = Math.max(backoffSeconds, parsed);
					}
				}

				blockedUntil = Date.now() + backoffSeconds * 1000;

				// X-Rate-Limit-Source: "app" (our checkRateLimit) | "upstream" (provider/gateway)
				const source = response.headers.get("X-Rate-Limit-Source");
				handleRateLimitError(cloned, source);
			} else {
				// Every other non-ok status routes through the shared describer,
				// which ALWAYS returns copy. This replaced an `else if` chain with
				// no final `else`, under which any unnamed status — 402 above all,
				// the code a provider returns when the account is out of credit —
				// produced no toast whatsoever.
				void toastFromResponse(
					response.status,
					cloned,
					billingActionRef.current,
				);

				// A refused body is the one failure the surface owning the
				// attachments has to hear about: the entry that breached the cap
				// rides every later turn, so the thread stays refused until
				// something drops it. This patch is module-level and holds no
				// React context, so the owner is told by event rather than by
				// callback — the same seam as `GET_STARTED_PROJECT_TAB_EVENT`.
				if (response.status === 413) {
					window.dispatchEvent(
						new CustomEvent(AI_REQUEST_TOO_LARGE_EVENT),
					);
				}
			}

			return response;
		};

		return () => {
			window.fetch = originalFetch;
			patchedRef.current = false;
		};
	}, []);

	return null;
}

/**
 * Read whatever the AI endpoint returned and surface it. Body parsing is
 * best-effort: `describeAiError` still produces status-based copy when the
 * body is empty, already consumed, or not JSON, so a failure here degrades the
 * message rather than losing the toast.
 */
async function toastFromResponse(
	status: number,
	response: Response,
	billingAction: AiErrorToastAction | undefined,
) {
	let body: unknown;
	try {
		const contentType = response.headers.get("content-type") ?? "";
		body = contentType.includes("application/json")
			? await response.json()
			: await response.text();
	} catch {
		body = undefined;
	}
	const copy = describeAiError(status, body);
	showPersistentAiErrorToast(
		copy.title,
		copy.description,
		Date.now(),
		copy.billingActionable ? billingAction : undefined,
	);
}

async function handleRateLimitError(response: Response, source: string | null) {
	let retryAfter: number | null = null;

	// Try Retry-After header first
	const headerValue = response.headers.get("Retry-After");
	if (headerValue) {
		retryAfter = Number.parseInt(headerValue, 10);
	}

	// Fall back to response body
	if (!retryAfter) {
		try {
			const body = await response.json();
			if (body.retryAfter) {
				retryAfter = body.retryAfter;
			}
		} catch {
			// Body may already be consumed or not JSON
		}
	}

	const wait = retryAfter
		? `Retrying in ${retryAfter} seconds…`
		: "Please retry in a moment.";
	let title: string;
	let detail: string;
	if (source === "upstream") {
		title = "AI provider is busy";
		detail = `The upstream AI provider is rate-limiting requests. ${wait}`;
	} else if (source === "client-backoff") {
		title = "Slowing down requests";
		detail = `Too many AI requests in a row — pausing briefly. ${wait}`;
	} else {
		title = "AI service is busy";
		detail = `Too many AI requests in a short period. ${wait}`;
	}

	// Transient: keeps a finite countdown so the "Retrying in Ns…" copy can't
	// linger after the wait window has elapsed.
	showTransientAiErrorToast(
		title,
		detail,
		retryAfter ? retryAfter * 1000 : 10_000,
	);
}
