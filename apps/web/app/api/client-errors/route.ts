/**
 * Ingest for `apps/web/modules/shared/lib/rpc-failure-report.ts` — the two
 * oRPC failure shapes the API's own `rpc.error` log line never saw (a
 * transport failure, a rewrapped proxy/platform error page). Modeled on
 * `app/api/security/csp-report/route.ts`'s shape (size-capped, content-type
 * checked, parsing never throws, logged as structured data, 204 always).
 *
 * Differs from that route in the two places a browser-analytics beacon needs
 * to differ from a security report: this one requires a session (a CSP
 * report has none to check, and accepting anonymous reports here would let
 * anyone spam the endpoint) and it is rate-limited per user rather than left
 * open (CSP reports are already bounded by the pages that can trigger one).
 */

import { checkRateLimit } from "@repo/api/lib/rate-limit";
import { logger } from "@repo/logs";
import { getSession } from "@saas/auth/lib/server";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_REPORTS_PER_BATCH = 20;
const RATE_LIMIT = { limit: 30, windowMs: 60_000 };

const reportSchema = z.object({
	procedure: z.string().min(1).max(200),
	kind: z.enum(["transport", "error-page"]),
	status: z.number().int().min(100).max(599).optional(),
	code: z.string().max(100).optional(),
	route: z.string().max(300),
});

const batchSchema = z.object({
	reports: z.array(reportSchema).min(1).max(MAX_REPORTS_PER_BATCH),
});

/**
 * Same pattern as `app/api/consent/route.ts`'s `isCrossSitePost`: browsers
 * send `Origin` on every POST, so only a PRESENT-and-mismatched value is
 * rejected — an absent header (some legitimate same-origin requests omit
 * it) is not itself treated as cross-site.
 */
function isCrossSitePost(request: Request): boolean {
	const origin = request.headers.get("origin");
	if (!origin) {
		return false;
	}
	const host = request.headers.get("host") ?? new URL(request.url).host;
	try {
		return new URL(origin).host !== host;
	} catch {
		return true;
	}
}

const NO_CONTENT = { status: 204 } as const;

export async function POST(request: Request): Promise<NextResponse> {
	const session = await getSession();
	if (!session) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	if (isCrossSitePost(request)) {
		return NextResponse.json(
			{ error: "Cross-site requests are not accepted" },
			{ status: 403 },
		);
	}

	const contentType = (
		request.headers.get("content-type") ?? ""
	).toLowerCase();
	if (!contentType.includes("application/json")) {
		return NextResponse.json(
			{ error: "Unsupported content type" },
			{ status: 400 },
		);
	}

	// Reject on the declared size before reading the body at all — a
	// present `Content-Length` over budget need not be buffered first. A
	// missing or lying header still gets caught by the post-read check
	// below (measured in bytes, not UTF-16 code units — `.length` on a
	// string with any multi-byte character undercounts the actual payload).
	const declaredLength = Number(request.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
		return NextResponse.json(
			{ error: "Payload too large" },
			{
				status: 413,
			},
		);
	}

	const text = await request.text();
	if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
		return NextResponse.json(
			{ error: "Payload too large" },
			{
				status: 413,
			},
		);
	}

	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
	}

	const parsed = batchSchema.safeParse(payload);
	if (!parsed.success) {
		return NextResponse.json(
			{ error: "Invalid report batch" },
			{ status: 400 },
		);
	}

	const rateLimitResult = await checkRateLimit(
		`client-errors:${session.user.id}`,
		RATE_LIMIT.limit,
		RATE_LIMIT.windowMs,
	);
	if (!rateLimitResult.allowed) {
		return new NextResponse(
			JSON.stringify({
				error: "Rate limit exceeded",
				retryAfter: rateLimitResult.resetInSeconds,
			}),
			{
				status: 429,
				headers: {
					"Content-Type": "application/json",
					"Retry-After": rateLimitResult.resetInSeconds.toString(),
				},
			},
		);
	}

	for (const report of parsed.data.reports) {
		// The sink attached in `instrumentation.ts` forwards this to App
		// Insights — see `packages/logs/lib/logger.ts`'s `addLogSink`.
		logger.warn(
			{ event: "client.rpc_failure", ...report },
			"[client-errors] reported oRPC failure the server never saw",
		);
	}

	return new NextResponse(null, NO_CONTENT);
}
