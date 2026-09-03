/**
 * Teams hosted-content helpers for the chat-thread image-attachments feature.
 *
 * Two surface area pieces:
 *
 *   1. `extractHostedContentRefsFromHtml(html, messageId)` — pure parser that
 *      walks `<img>` tags in a Teams message body's HTML, extracts each one's
 *      Graph `hostedContents/{id}` segment, and returns
 *      `TeamsHostedContentRef[]`. Tolerant of malformed HTML — never throws.
 *      Dedups by `hostedContent.id` within one message (decisions § 12).
 *
 *   2. `downloadTeamsHostedContent(ref, accessToken, opts)` — authenticated
 *      Graph GET. Prefers `ref.srcUrl` (verbatim from the `<img src>` Teams
 *      emitted) over a URL reconstructed from `messageUrl`. Streams the body
 *      with a `maxBytes` ceiling, honors an `AbortSignal`. Retries on 429
 *      (up to 3 with backoff per FR-20) AND on 404 (up to 2 with backoff,
 *      workaround for the intermittent Graph bug in MS Q&A 707816). After
 *      404 retries exhaust on a reply-scoped URL, falls back ONCE to the
 *      root-URL form (drops the `/replies/{replyId}/` segment) since
 *      hostedContents appear to live under the thread root's collection.
 *
 * The two are independently importable — both are used by the central
 * apply-time orchestrator `attachPendingMediaToStory`, and the parser is
 * also used by the Teams channel-monitor fetch activity to populate
 * `PendingBacklogProposal.sourceMetadata.attachments` at proposal-create
 * time without paying for a download.
 *
 * Security contract:
 *  - The Graph access token is sent only as an `Authorization: Bearer …`
 *    header. It is NEVER included in any thrown message or log statement.
 *  - The signed hostedContent URL is treated as sensitive and is NEVER
 *    logged or surfaced in error messages — only the `refId` (hostedContent
 *    id) and HTTP status are.
 *  - Only `https://` URLs are accepted by the downloader. Non-HTTPS callers
 *    fail at the boundary with `DownloadFailedError` before any network IO.
 *
 * Failure mapping:
 *  - 401 / 403 / 5xx                            → `DownloadFailedError`
 *  - 429 after 3 retries (with `Retry-After`)   → `DownloadFailedError`
 *  - byte-cap exceeded / abort / network error  → `DownloadFailedError`
 */

import type { TeamsHostedContentRef } from "../shared/attachment-types";
import { DownloadFailedError } from "./hosted-content.errors";

// =============================================================================
// extractHostedContentRefsFromHtml
// =============================================================================

/**
 * Match a `hostedContents/{id}` segment in a Graph URL. The id is everything
 * up to the next `/`, `"`, or end-of-string. We DO NOT anchor the pattern to
 * `graph.microsoft.com` because Teams sometimes serves the same URL through
 * regional Graph hosts; the segment shape is what's reliable.
 */
const HOSTED_CONTENTS_ID_PATTERN = /hostedContents\/([^/"\s]+)/i;

/**
 * Whitelist for the `srcUrl` field. Teams may serve hostedContents from
 * regional Graph hosts in the future; today only `graph.microsoft.com`
 * accepts a Bearer issued by the standard Graph OAuth flow, so we use the
 * verbatim src ONLY when it's that host. Anything else falls back to the
 * legacy reconstruction path.
 */
const GRAPH_HOST_PREFIX = "https://graph.microsoft.com/";

/**
 * Minimal HTML entity decoder for `<img src>` values. Teams emits ampersands
 * in URLs encoded as `&amp;` inside HTML — passing the raw string to `fetch`
 * would treat `amp;` as the next param key. We only need the entities that
 * realistically appear in a URL.
 */
function decodeHtmlEntities(value: string): string {
	return value
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

/**
 * Walk `<img>` tags in a Teams message body. Returns one
 * `TeamsHostedContentRef` per unique `hostedContent.id` (dedup per message
 * per decisions § 12). Tolerant of malformed HTML — `<img>` tags that don't
 * have a parseable hostedContent id are skipped silently (this is the same
 * tolerance as `get_message_hosted_content` Strategy 1 in `index.ts`).
 *
 * The full `<img src>` URL is preserved on `ref.srcUrl` when it points at
 * `graph.microsoft.com` — at apply time the downloader uses that URL
 * verbatim. Reconstructing the URL from `messageId` + `parentMessageId` has
 * historically been wrong for replies (bug_002, then again post-fix); Teams
 * already knows the canonical URL, so we use what it wrote.
 *
 * @param html              Raw `body.content` from a Teams message — may be
 *                          empty, may contain malformed/unclosed tags.
 * @param messageId         The id of the message that contains this `<img>`.
 *                          For root-message images this is the thread root;
 *                          for reply images this is the reply id.
 * @param parentMessageId   When the html is a REPLY body, pass the thread
 *                          root id here. Used by the legacy reconstruction
 *                          path in the downloader (kept for backward-compat
 *                          with refs persisted before `srcUrl` existed).
 *                          Omit / pass `undefined` for root-message bodies.
 */
export function extractHostedContentRefsFromHtml(
	html: string,
	messageId: string,
	parentMessageId?: string,
): TeamsHostedContentRef[] {
	if (!html) {
		return [];
	}

	const refs: TeamsHostedContentRef[] = [];
	const seenIds = new Set<string>();

	// Match `<img …>` tags with any attribute ordering. The pattern is
	// permissive — `[^>]*?` allows attributes in any order, `[^>]*` lets us
	// keep going when the tag is malformed (e.g. unclosed). This is the same
	// strategy `get_message_hosted_content` Strategy 1 uses today.
	const imgPattern = /<img\b[^>]*>/gi;

	for (const match of html.matchAll(imgPattern)) {
		const imgTag = match[0];

		// Extract src — required.
		const srcMatch = imgTag.match(/\bsrc\s*=\s*"([^"]+)"/i);
		if (!srcMatch) {
			continue;
		}
		const rawSrc = srcMatch[1];

		// Skip emoji/icon images and data URIs (same heuristic as
		// `get_message_hosted_content`).
		if (rawSrc.startsWith("data:") || rawSrc.includes("emoji")) {
			continue;
		}

		// Decode HTML entities so the URL is fetch-ready. Teams emits `&amp;`
		// inside `<img src>` values; passing that to `fetch` makes the second
		// query param key be `amp;…` instead of the intended key.
		const src = decodeHtmlEntities(rawSrc);

		// Extract the hostedContent id from the src URL. If the src isn't a
		// hostedContents URL (e.g. an external avatar), skip silently.
		const idMatch = src.match(HOSTED_CONTENTS_ID_PATTERN);
		if (!idMatch) {
			continue;
		}
		const id = idMatch[1];
		if (seenIds.has(id)) {
			// Same hostedContent reposted within one message — dedup.
			continue;
		}
		seenIds.add(id);

		// Preserve the verbatim Graph URL ONLY when it points at the canonical
		// Graph host. Non-canonical hosts (regional, Skype CMS) require an
		// auth we don't currently have, so we let the downloader fall back to
		// the legacy reconstruction path for those.
		const srcUrl = src.startsWith(GRAPH_HOST_PREFIX) ? src : undefined;

		// Best-effort alt extraction (decisions § 11 — alt-text fallback).
		const altMatch = imgTag.match(/\balt\s*=\s*"([^"]*)"/i);
		const altText = altMatch ? altMatch[1] : undefined;

		const ref: TeamsHostedContentRef = {
			id,
			messageId,
			// Content-Type is not known until we download. The downloader
			// fills this in via the `Content-Type` response header.
			contentType: "application/octet-stream",
			...(parentMessageId !== undefined ? { parentMessageId } : {}),
			...(srcUrl !== undefined ? { srcUrl } : {}),
			...(altText !== undefined && altText !== "" ? { altText } : {}),
		};
		refs.push(ref);
	}

	return refs;
}

// =============================================================================
// downloadTeamsHostedContent
// =============================================================================

/**
 * URL prefix patterns for the `hostedContents/{id}/$value` blob endpoint.
 *
 * Channel messages live under `/teams/{teamId}/channels/{channelId}/messages/`
 * and chat messages live under `/chats/{chatId}/messages/` or
 * `/me/chats/{chatId}/messages/`. The caller knows which family the ref
 * belongs to (the Teams Channel Monitor only deals in channel messages; the
 * AI Assistant flow handles both). For the channel-monitor case we accept
 * the prefix in the options bag — keeps the helper integration-agnostic.
 */
export interface DownloadTeamsHostedContentOptions {
	/**
	 * AbortController signal — propagated to `fetch`. The caller's overall
	 * approval-time budget controller (`APPROVAL_BUDGET_MS`) wires this.
	 */
	signal?: AbortSignal;
	/**
	 * Hard byte ceiling for the download. When cumulative bytes exceed this,
	 * the read is aborted and `DownloadFailedError("image_too_large")` is
	 * thrown. Matches `MAX_BYTES_PER_IMAGE` in `attachment-constants.ts`.
	 */
	maxBytes: number;
	/**
	 * The fully qualified Graph URL prefix for the parent message — the
	 * helper appends `/hostedContents/{ref.id}/$value` to construct the
	 * final download URL. Required because the message can live under
	 * either `/teams/{teamId}/channels/{channelId}/messages/{messageId}` or
	 * `/chats/{chatId}/messages/{messageId}` and the helper itself doesn't
	 * know which.
	 *
	 * Examples:
	 *   `https://graph.microsoft.com/v1.0/teams/T/channels/C/messages/M`
	 *   `https://graph.microsoft.com/v1.0/chats/C/messages/M`
	 */
	messageUrl: string;
	/**
	 * Graph base for retry construction. Optional — if not supplied, the
	 * helper uses the production Graph endpoint. Exposed for test mocks.
	 */
	graphBaseUrl?: string;
}

export interface DownloadTeamsHostedContentResult {
	buffer: Buffer;
	mime: string;
	size: number;
	contentDisposition?: string;
}

/**
 * Parse a `Retry-After` header value into a millisecond delay. Honors both
 * seconds-format (e.g. `"10"`) and HTTP-date format. Returns `null` when the
 * header is missing or unparseable so the caller can fall back to its own
 * backoff schedule.
 */
function parseRetryAfterMs(headerValue: string | null): number | null {
	if (!headerValue) {
		return null;
	}
	const trimmed = headerValue.trim();
	const seconds = Number(trimmed);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return Math.floor(seconds * 1000);
	}
	const dateMs = Date.parse(trimmed);
	if (Number.isFinite(dateMs)) {
		const delta = dateMs - Date.now();
		return delta > 0 ? delta : 0;
	}
	return null;
}

/**
 * Sleep with abort support. Used between 429 retries. The returned promise
 * resolves normally on completion, rejects with an `AbortError` if the
 * signal fires before the delay elapses.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException("aborted", "AbortError"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new DOMException("aborted", "AbortError"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Build the "root-URL fallback" for a reply hostedContent URL. Microsoft
 * Graph has a known intermittent bug where `$value` on a reply hostedContent
 * returns 404 even when the content exists (see Microsoft Q&A 707816 — "When
 * attempting to get hostedContents content stream using $value, NotFound
 * error is returned"). Empirically, the same content is often retrievable
 * via the ROOT message's URL (no `/replies/{replyId}/` segment) because
 * hostedContents are written into the thread root's collection.
 *
 * This helper strips a `/messages/{root}/replies/{reply}/` segment to
 * `/messages/{root}/`, leaving the rest of the path (incl. `/hostedContents/`
 * and `/$value`) intact. Returns `null` when the input doesn't match the
 * reply-scoped shape — root URLs and chat URLs have no fallback.
 */
function deriveRootFallbackUrl(url: string): string | null {
	// Bounded span: js/polynomial-redos — a real Graph hostedContent URL is
	// nowhere near this long; capping keeps the regex off unbounded input.
	if (url.length > 2048) {
		return null;
	}
	const m = url.match(
		/^(.+\/messages\/[^/]+)\/replies\/[^/]+(\/hostedContents\/.+)$/,
	);
	return m ? `${m[1]}${m[2]}` : null;
}

/**
 * Best-effort capture of Microsoft Graph's `error.code` from a 404 / non-2xx
 * response body. Graph responses look like
 *   `{"error":{"code":"NotFound","message":"...","innerError":{"request-id":"..."}}}`
 * — we extract only `code` and `request-id` so future debugging has anchor
 * points without surfacing free-form messages that may echo identifiers.
 * Bounded by a 4KB body read so a misbehaving server can't blow the buffer.
 */
async function readGraphErrorCode(
	response: Response,
): Promise<{ code?: string; requestId?: string }> {
	try {
		const reader = response.body?.getReader();
		if (!reader) {
			return {};
		}
		const chunks: Uint8Array[] = [];
		let received = 0;
		const MAX = 4096;
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			if (value) {
				received += value.byteLength;
				if (received > MAX) {
					try {
						await reader.cancel();
					} catch {
						// noop
					}
					break;
				}
				chunks.push(value);
			}
		}
		const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString(
			"utf8",
		);
		const parsed = JSON.parse(text) as {
			error?: {
				code?: string;
				innerError?: { "request-id"?: string };
			};
		};
		return {
			...(typeof parsed.error?.code === "string"
				? { code: parsed.error.code }
				: {}),
			...(typeof parsed.error?.innerError?.["request-id"] === "string"
				? { requestId: parsed.error.innerError["request-id"] }
				: {}),
		};
	} catch {
		return {};
	}
}

/**
 * Single-URL fetch + byte-cap stream read. Returns either the parsed result
 * or a structured non-2xx outcome that the outer retry/fallback layer can
 * branch on. Never throws on HTTP status — the caller decides whether the
 * status triggers a retry, a fallback, or a hard failure.
 */
async function attemptDownload(
	url: string,
	accessToken: string,
	signal: AbortSignal | undefined,
	maxBytes: number,
): Promise<
	| { kind: "ok"; result: DownloadTeamsHostedContentResult }
	| { kind: "status"; status: number; response: Response }
	| { kind: "error"; cause: unknown }
> {
	let response: Response;
	try {
		response = await fetch(url, {
			headers: { Authorization: `Bearer ${accessToken}` },
			signal,
		});
	} catch (cause) {
		return { kind: "error", cause };
	}

	const status = response.status;
	if (status < 200 || status >= 300) {
		return { kind: "status", status, response };
	}

	const body = response.body;
	if (!body) {
		return { kind: "status", status, response };
	}

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			if (value) {
				received += value.byteLength;
				if (received > maxBytes) {
					try {
						await reader.cancel();
					} catch {
						// best-effort cleanup
					}
					throw new DownloadFailedError("image_too_large", {
						status,
					});
				}
				chunks.push(value);
			}
		}
	} catch (err) {
		if (err instanceof DownloadFailedError) {
			throw err;
		}
		throw new DownloadFailedError(
			"Teams hosted-content stream read failed",
			{
				cause: err,
				status,
			},
		);
	}

	const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
	const mime =
		response.headers.get("content-type") ?? "application/octet-stream";
	const contentDisposition =
		response.headers.get("content-disposition") ?? undefined;
	return {
		kind: "ok",
		result: {
			buffer,
			mime,
			size: buffer.byteLength,
			...(contentDisposition !== undefined ? { contentDisposition } : {}),
		},
	};
}

/**
 * Download a single Teams hosted-content blob authenticated with the user's
 * Microsoft Graph access token. Streams the body with a hard byte ceiling
 * and surfaces typed failures so the orchestrator can map each one to a
 * single `AttachmentWarning.reason`.
 *
 * Resolution policy:
 *  1. Primary URL is `ref.srcUrl` when present (the verbatim `<img src>` Teams
 *     emitted), otherwise the reconstructed `${messageUrl}/hostedContents/{id}/$value`.
 *  2. **429**: retried up to 3 additional attempts (FR-20). Honors
 *     `Retry-After` when present, else 1s / 2s / 4s backoff.
 *  3. **404**: retried up to 2 additional attempts with 1s / 2s backoff.
 *     Microsoft Graph has a known intermittent 404 bug on `$value` for
 *     hostedContents — especially replies (Microsoft Q&A 707816). After
 *     retries exhaust, falls back ONCE to the root-URL form
 *     `/messages/{rootId}/hostedContents/{id}/$value` (dropping the
 *     `/replies/{replyId}/` segment) — hostedContents appear to live under
 *     the thread root's collection.
 *  4. **other non-2xx, network errors, byte-cap overflow, abort**: thrown as
 *     `DownloadFailedError` immediately. Error message includes Graph's
 *     `error.code` and `request-id` when available — never the URL or token.
 */
export async function downloadTeamsHostedContent(
	ref: TeamsHostedContentRef,
	accessToken: string,
	options: DownloadTeamsHostedContentOptions,
): Promise<DownloadTeamsHostedContentResult> {
	const { signal, maxBytes, messageUrl } = options;

	// Prefer the verbatim Graph URL Teams emitted in the `<img src>`. Falling
	// back to messageUrl-based reconstruction is the legacy path for refs
	// persisted before `ref.srcUrl` was added.
	const primaryUrl =
		ref.srcUrl !== undefined
			? ref.srcUrl
			: `${messageUrl}/hostedContents/${ref.id}/$value`;

	// HTTPS-only boundary.
	if (!primaryUrl.startsWith("https://")) {
		throw new DownloadFailedError(
			"Teams hosted-content URL must use https://",
		);
	}

	const MAX_RETRIES_AFTER_429 = 3;
	const RETRIES_AFTER_404 = 2;
	const BACKOFF_MS = [1000, 2000, 4000];

	// Compute the root-URL fallback once. Null when the primary URL isn't
	// reply-scoped (root messages and chats have no `/replies/{x}/` segment).
	const rootFallbackUrl = deriveRootFallbackUrl(primaryUrl);

	// Try primary URL with 429 + 404 retries, then optionally fall back to the
	// root URL on continued 404.
	const urlsToTry: string[] = [primaryUrl];
	if (rootFallbackUrl !== null) {
		urlsToTry.push(rootFallbackUrl);
	}

	let lastGraphCode: string | undefined;
	let lastGraphRequestId: string | undefined;
	let lastStatus: number | undefined;

	for (let urlIdx = 0; urlIdx < urlsToTry.length; urlIdx++) {
		const url = urlsToTry[urlIdx] as string;
		let attempt429 = 0;
		let attempt404 = 0;

		while (true) {
			const outcome = await attemptDownload(
				url,
				accessToken,
				signal,
				maxBytes,
			);

			if (outcome.kind === "ok") {
				return outcome.result;
			}

			if (outcome.kind === "error") {
				throw new DownloadFailedError(
					"Teams hosted-content fetch failed",
					{ cause: outcome.cause },
				);
			}

			// outcome.kind === "status"
			const { status, response } = outcome;
			lastStatus = status;

			if (status === 429 && attempt429 < MAX_RETRIES_AFTER_429) {
				const retryAfter = parseRetryAfterMs(
					response.headers.get("retry-after"),
				);
				const delayMs = retryAfter ?? BACKOFF_MS[attempt429] ?? 4000;
				attempt429++;
				try {
					await sleep(delayMs, signal);
				} catch (cause) {
					throw new DownloadFailedError(
						"Teams hosted-content retry aborted",
						{ cause },
					);
				}
				continue;
			}

			if (status === 429) {
				throw new DownloadFailedError("rate_limited", { status });
			}

			if (status === 404) {
				// Capture Graph's error code on the first 404 so the error has
				// useful diagnostic anchor points if we eventually give up.
				const errInfo = await readGraphErrorCode(response);
				if (errInfo.code !== undefined) {
					lastGraphCode = errInfo.code;
				}
				if (errInfo.requestId !== undefined) {
					lastGraphRequestId = errInfo.requestId;
				}

				// Retry the SAME URL up to 2 times with backoff (timing-issue
				// workaround per Microsoft Q&A 707816).
				if (attempt404 < RETRIES_AFTER_404) {
					attempt404++;
					try {
						await sleep(BACKOFF_MS[attempt404 - 1] ?? 1000, signal);
					} catch (cause) {
						throw new DownloadFailedError(
							"Teams hosted-content retry aborted",
							{ cause },
						);
					}
					continue;
				}

				// Retries exhausted on this URL. If there's a fallback URL
				// queued, break out of the inner loop so we try it next.
				if (urlIdx + 1 < urlsToTry.length) {
					break;
				}

				// No fallback left — propagate with diagnostic context. The
				// `lastGraphCode`/`lastGraphRequestId` carry the most useful
				// debugging signal for a Microsoft support ticket.
				const detailParts: string[] = ["404"];
				if (lastGraphCode !== undefined) {
					detailParts.push(`code=${lastGraphCode}`);
				}
				if (lastGraphRequestId !== undefined) {
					detailParts.push(`requestId=${lastGraphRequestId}`);
				}
				throw new DownloadFailedError(detailParts.join(";"), {
					status: 404,
				});
			}

			// Any other non-2xx — throw immediately, capturing Graph error
			// code when present.
			const errInfo = await readGraphErrorCode(response);
			const detailParts: string[] = [`${status}`];
			if (errInfo.code !== undefined) {
				detailParts.push(`code=${errInfo.code}`);
			}
			if (errInfo.requestId !== undefined) {
				detailParts.push(`requestId=${errInfo.requestId}`);
			}
			throw new DownloadFailedError(detailParts.join(";"), { status });
		}
	}

	// Unreachable when urlsToTry is non-empty, but TypeScript requires a
	// terminal expression on this branch.
	const detailParts: string[] = [`${lastStatus ?? "unknown"}`];
	if (lastGraphCode !== undefined) {
		detailParts.push(`code=${lastGraphCode}`);
	}
	if (lastGraphRequestId !== undefined) {
		detailParts.push(`requestId=${lastGraphRequestId}`);
	}
	throw new DownloadFailedError(detailParts.join(";"), {
		...(lastStatus !== undefined ? { status: lastStatus } : {}),
	});
}
