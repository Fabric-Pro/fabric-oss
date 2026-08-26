import { logger } from "@repo/logs";
import { type NextRequest, NextResponse } from "next/server";

/**
 * CSP violation report sink (SOC 2 CC6.6).
 *
 * The app ships a `Content-Security-Policy-Report-Only` header (see
 * next.config.ts) so we can measure what a future *enforced* CSP would break
 * before turning it on. Browsers POST violation reports here; we log them and
 * return 204.
 *
 * Unauthenticated by design — browsers send CSP reports without credentials.
 * Abuse is bounded: the body is size-capped, only report content-types are
 * accepted, the payload is logged as structured data (never interpolated into
 * the message, so no log injection), and parsing never throws.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024;
const REPORT_CONTENT_TYPES = [
	"application/csp-report",
	"application/reports+json",
	"application/json",
];

const NO_CONTENT = { status: 204 } as const;

export async function POST(req: NextRequest): Promise<NextResponse> {
	try {
		const contentType = (
			req.headers.get("content-type") ?? ""
		).toLowerCase();
		if (!REPORT_CONTENT_TYPES.some((t) => contentType.includes(t))) {
			return new NextResponse(null, NO_CONTENT);
		}

		const text = await req.text();
		if (!text || text.length > MAX_BODY_BYTES) {
			return new NextResponse(null, NO_CONTENT);
		}

		let payload: unknown;
		try {
			payload = JSON.parse(text);
		} catch {
			return new NextResponse(null, NO_CONTENT);
		}

		// `report-uri` sends `{ "csp-report": {...} }`; the newer `report-to`
		// Reporting API sends an array of `{ type, body, ... }`. Normalize both.
		const reports = Array.isArray(payload)
			? payload
			: payload && typeof payload === "object" && "csp-report" in payload
				? [(payload as Record<string, unknown>)["csp-report"]]
				: [payload];

		for (const report of reports) {
			logger.warn(
				{ event: "security.csp.violation", report },
				"[CSP] Report-Only violation",
			);
		}
	} catch {
		// A malformed report must never error the endpoint.
	}
	return new NextResponse(null, NO_CONTENT);
}
