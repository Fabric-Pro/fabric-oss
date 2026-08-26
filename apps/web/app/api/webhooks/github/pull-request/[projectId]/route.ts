/**
 * Per-project pull-request review webhook.
 *
 * Endpoint: POST /api/webhooks/github/pull-request/{projectId}
 *
 * Point a repository's webhook here with the `pull_request` event and the
 * project's own webhook secret — the same secret the CI-results webhook uses,
 * managed in Settings ▸ Testing.
 *
 * Prefer this over the shared `/api/webhooks/github/pull-request` endpoint. The
 * shared one verifies a single deployment-wide secret that every customer admin
 * is told to configure, so a delivery signed with it does not identify a tenant;
 * this one is addressed to a project and verifies that project's own secret, so
 * a delivery can only ever reach the project it was sent to.
 *
 * The rate limit and the body cap below mirror the CI-results webhook
 * deliberately: this endpoint is unauthenticated until the signature is checked,
 * and the signature cannot be checked without first reading the whole body. So
 * both guards have to sit in front of that read rather than after it.
 */

import { createHash } from "node:crypto";
import { checkRateLimit, RATE_LIMIT_PRESETS } from "@repo/api/lib/rate-limit";
import { handleProjectPullRequestWebhook } from "@repo/api/modules/projects/procedures/pr-review/project-pull-request-webhook";
import { type NextRequest, NextResponse } from "next/server";

/** Same ceiling as the CI-results webhook. A pull_request payload is far under it. */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Per project AND per client, so one noisy sender cannot exhaust another
 * project's allowance. Falls back to a hash of two request headers when no
 * trusted proxy header is configured — a weak key, but a shared one is worse.
 */
function rateLimitKey(request: NextRequest, projectId: string): string {
	const trustedHeader = process.env.TRUSTED_PROXY_IP_HEADER?.toLowerCase();
	let client = "unknown";
	if (trustedHeader === "cf-connecting-ip") {
		client = request.headers.get("cf-connecting-ip") ?? client;
	} else if (trustedHeader === "x-real-ip") {
		client = request.headers.get("x-real-ip") ?? client;
	} else if (trustedHeader === "x-forwarded-for") {
		client =
			request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
			client;
	}
	if (client === "unknown") {
		client = createHash("sha256")
			.update(
				`${request.headers.get("user-agent") ?? ""}${request.headers.get("accept-language") ?? ""}`,
			)
			.digest("hex")
			.slice(0, 16);
	}
	return `pr-review-webhook:${projectId}:${client}`;
}

export async function POST(
	request: NextRequest,
	context: { params: Promise<{ projectId: string }> },
) {
	try {
		const { projectId } = await context.params;

		const { limit, windowMs } = RATE_LIMIT_PRESETS.webhook;
		const rateLimit = await checkRateLimit(
			rateLimitKey(request, projectId),
			limit,
			windowMs,
		);
		if (!rateLimit.allowed) {
			return NextResponse.json(
				{ handled: false, reason: "rate-limited" },
				{
					status: rateLimit.statusCode ?? 429,
					headers: {
						"Retry-After": String(rateLimit.resetInSeconds),
					},
				},
			);
		}

		// Refuse an oversized body from its declared length, before buffering it.
		const declared = Number(request.headers.get("content-length") ?? 0);
		if (declared > MAX_BODY_BYTES) {
			return NextResponse.json(
				{ handled: false, reason: "payload-too-large" },
				{ status: 413 },
			);
		}

		// Raw body first: the signature is over the exact bytes the sender sent,
		// and re-serialising parsed JSON would not reproduce them.
		const rawBody = await request.text();
		// A missing or lying content-length is why this is checked twice.
		if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
			return NextResponse.json(
				{ handled: false, reason: "payload-too-large" },
				{ status: 413 },
			);
		}

		let payload: unknown;
		try {
			payload = JSON.parse(rawBody);
		} catch {
			return NextResponse.json(
				{ error: "Invalid JSON payload" },
				{ status: 400 },
			);
		}

		const result = await handleProjectPullRequestWebhook({
			projectId,
			signatureHeader:
				request.headers.get("x-hub-signature-256") ||
				request.headers.get("x-fabric-qa-signature") ||
				"",
			eventName: request.headers.get("x-github-event") || "",
			rawBody,
			payload,
		});

		return NextResponse.json(
			{
				handled: result.handled,
				reason: result.reason ?? null,
				projects: result.projects ?? 0,
			},
			{ status: result.status },
		);
	} catch (error) {
		console.error("[GitHub PR Webhook] Error:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}

/** Some services probe with GET before they will save a webhook URL. */
export async function GET() {
	return NextResponse.json({
		status: "ok",
		service: "Fabric per-project pull-request review webhook",
	});
}
