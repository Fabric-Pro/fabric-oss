/**
 * Webhook Trigger API Route
 * Allows external systems to trigger published workflows via HTTP
 *
 * POST /api/workflows/trigger/[workflowId]
 *
 * Authentication:
 * - Bearer token (workflow API key)
 * - Webhook signature (HMAC-SHA256 with webhook secret)
 *
 * Request body:
 * - Any JSON payload that will be passed to the workflow trigger node
 */

import crypto from "node:crypto";
import { checkRateLimit } from "@repo/api/lib/rate-limit";
import {
	concurrencyRefusalMessage,
	createExecutionWithinConcurrencyCap,
} from "@repo/api/modules/workflows/lib/execution-concurrency";
import {
	attemptWorkflowBuilderStart,
	startFailureMessage,
	unconfirmedStartMessage,
} from "@repo/api/modules/workflows/lib/start-builder-execution";
import { db, markExecutionRunningIfPending } from "@repo/database";
import { decryptApiKeyMaybe } from "@repo/utils";
import { type NextRequest, NextResponse } from "next/server";

/**
 * Webhook trigger rate limit: 60 requests per minute, keyed by caller IP and
 * workflow.
 *
 * This used to be a module-level `Map`, which meant the limit was per process:
 * with N instances a caller got N x 60, and the counter reset on every deploy.
 * `checkRateLimit` is backed by Redis when it is configured, so the limit is
 * shared — and it fails closed in production when Redis is missing, rather
 * than silently degrading to no protection at all.
 */
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

interface RouteParams {
	params: Promise<{ workflowId: string }>;
}

/**
 * Verify webhook signature using HMAC-SHA256
 */
function verifyWebhookSignature(
	payload: string,
	signature: string,
	secret: string,
): boolean {
	const expectedSignature = crypto
		.createHmac("sha256", secret)
		.update(payload)
		.digest("hex");

	// Use timing-safe comparison to prevent timing attacks
	try {
		return crypto.timingSafeEqual(
			Buffer.from(signature),
			Buffer.from(`sha256=${expectedSignature}`),
		);
	} catch {
		return false;
	}
}

/**
 * Verify API key by comparing hash and rejecting any key whose tenant
 * disagrees with the target workflow's tenant.
 */
async function verifyApiKey(
	workflowId: string,
	apiKey: string,
	workflow: { userId: string | null; organizationId: string | null },
): Promise<{ valid: boolean; keyId?: string }> {
	// API keys have format: wfk_<prefix>_<secret>
	const parts = apiKey.split("_");
	if (parts.length < 3 || parts[0] !== "wfk") {
		return { valid: false };
	}

	const keyPrefix = `wfk_${parts[1]}`;

	// Find the API key by prefix
	const storedKey = await db.workflowApiKey.findFirst({
		where: {
			workflowId,
			keyPrefix,
			isActive: true,
		},
	});

	if (!storedKey) {
		return { valid: false };
	}

	// Tenant binding runs before hash/expiration so a stale-tenant key
	// short-circuits without paying for the sha256. Key rows copy
	// `userId`/`organizationId` from the parent workflow at creation;
	// the execution attribution uses the workflow tenant, so the two
	// must agree.
	if (
		storedKey.userId !== workflow.userId ||
		storedKey.organizationId !== workflow.organizationId
	) {
		return { valid: false };
	}

	// Check expiration
	if (storedKey.expiresAt && storedKey.expiresAt < new Date()) {
		return { valid: false };
	}

	// Verify the key hash
	const keyHash = crypto.createHash("sha256").update(apiKey).digest("hex");
	if (keyHash !== storedKey.keyHash) {
		return { valid: false };
	}

	// Check permissions
	if (!storedKey.permissions.includes("trigger")) {
		return { valid: false };
	}

	// Update usage stats
	await db.workflowApiKey.update({
		where: { id: storedKey.id },
		data: {
			lastUsedAt: new Date(),
			usageCount: { increment: 1 },
		},
	});

	return { valid: true, keyId: storedKey.id };
}

export async function POST(request: NextRequest, { params }: RouteParams) {
	const { workflowId } = await params;

	// Rate limiting - by IP + workflowId
	const clientIp =
		request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
		request.headers.get("x-real-ip") ||
		"unknown";
	const rateLimitKey = `webhook:${clientIp}:${workflowId}`;
	const { allowed, remaining, resetInSeconds, statusCode, reason } =
		await checkRateLimit(rateLimitKey, RATE_LIMIT, RATE_WINDOW_MS);

	if (!allowed) {
		// 503 when the limiter itself is unavailable, so a caller can tell
		// "you are being throttled" from "we cannot currently throttle you".
		const isUnavailable = reason === "ratelimit-unavailable";
		return NextResponse.json(
			{
				error: isUnavailable
					? "Rate limiting is temporarily unavailable. Please retry."
					: "Too many requests. Please try again later.",
			},
			{
				status: statusCode ?? 429,
				headers: {
					"Retry-After": String(resetInSeconds || 60),
					"X-RateLimit-Remaining": remaining.toString(),
				},
			},
		);
	}

	try {
		// Get raw body for signature verification
		const rawBody = await request.text();
		let payload: Record<string, unknown> = {};

		try {
			payload = rawBody ? JSON.parse(rawBody) : {};
		} catch {
			return NextResponse.json(
				{ error: "Invalid JSON payload" },
				{ status: 400 },
			);
		}

		// Fetch the workflow
		const workflow = await db.workflow.findUnique({
			where: { id: workflowId },
		});

		if (!workflow) {
			return NextResponse.json(
				{ error: "Workflow not found" },
				{ status: 404 },
			);
		}

		// Check if workflow is published
		if (workflow.status !== "PUBLISHED" && workflow.status !== "ACTIVE") {
			return NextResponse.json(
				{ error: "Workflow is not published" },
				{ status: 403 },
			);
		}

		// Check if webhook trigger is enabled
		if (workflow.triggerType !== "WEBHOOK") {
			return NextResponse.json(
				{ error: "Webhook trigger not enabled for this workflow" },
				{ status: 403 },
			);
		}

		// Authenticate the request
		const authHeader = request.headers.get("authorization");
		const signatureHeader = request.headers.get("x-workflow-signature");

		let authenticated = false;

		// Method 1: API Key authentication
		if (authHeader?.startsWith("Bearer ")) {
			const apiKey = authHeader.substring(7);
			const { valid } = await verifyApiKey(workflowId, apiKey, {
				userId: workflow.userId,
				organizationId: workflow.organizationId,
			});
			authenticated = valid;
		}

		// Method 2: Webhook signature authentication
		if (!authenticated && signatureHeader && workflow.webhookSecret) {
			authenticated = verifyWebhookSignature(
				rawBody,
				signatureHeader,
				// Decrypt-with-passthrough: existing plaintext secrets validate
				// unchanged; newly-published ones are encrypted at rest.
				decryptApiKeyMaybe(workflow.webhookSecret),
			);
		}

		if (!authenticated) {
			return NextResponse.json(
				{ error: "Unauthorized" },
				{ status: 401 },
			);
		}

		// The per-tenant cap protects the workflow-builder queue from one
		// tenant's backlog. The manual path refuses before creating a row; a
		// webhook is the path most able to flood, so it has to refuse too.
		// Rate limiting alone does not cover it: that is per caller IP, so a
		// distributed caller walks straight past it. The row is created
		// inside the reservation, so the cap holds under exactly that kind
		// of concurrent traffic rather than only when nobody races for it.
		const reservation = await createExecutionWithinConcurrencyCap({
			userId: workflow.userId,
			organizationId: workflow.organizationId,
			data: {
				workflowId,
				// The graph that ran, not the one that was published. Every
				// trigger path executes `workflow.nodes` — the version rows
				// exist for history and rollback — so stamping
				// `publishedVersion` labelled the run with a version whose
				// content was not what executed. Anyone comparing a failed run
				// against "version 3" was reading the wrong graph.
				version: workflow.version,
				triggerType: "WEBHOOK",
				triggerInput: payload as object,
			},
		});

		if (!reservation.allowed) {
			return NextResponse.json(
				{
					error: "Too many workflow executions in flight",
					message: concurrencyRefusalMessage(reservation),
				},
				{ status: 429, headers: { "Retry-After": "60" } },
			);
		}
		const execution = reservation.execution;

		// The webhook path used its own workflow id scheme (`workflow-<id>`),
		// so a cancel from the API or the UI — both of which derive the id
		// from the execution row — addressed a run that did not exist. The
		// shared helper is the one id scheme, and the one protocol for what a
		// failed start call means.
		const outcome = await attemptWorkflowBuilderStart({
			workflowId,
			executionId: execution.id,
			nodes: workflow.nodes as never,
			edges: workflow.edges as never,
			triggerData: payload,
			userId: workflow.userId,
			organizationId: workflow.organizationId ?? undefined,
			projectId: workflow.projectId ?? undefined,
		});

		if (outcome.status === "not-started") {
			// The row exists but nothing is going to run it — Temporal
			// confirmed that — and no sweeper reclaims a PENDING execution.
			// Record the terminal state so the run history says "failed to
			// start" rather than "queued" forever.
			console.error(
				"[Webhook Trigger] Failed to start execution:",
				outcome.error,
			);
			const failedAt = new Date();
			await db.workflowExecution.update({
				where: { id: execution.id },
				data: {
					status: "FAILED",
					error: startFailureMessage(outcome.error),
					completedAt: failedAt,
					duration:
						failedAt.getTime() - execution.startedAt.getTime(),
				},
			});

			return NextResponse.json(
				{
					error: "Failed to start workflow",
					executionId: execution.id,
				},
				{ status: 502 },
			);
		}

		if (outcome.status === "unknown") {
			// The start call failed and the follow-up describe could not
			// settle whether Temporal accepted it. The run may be in progress
			// under the deterministic id, so the row stays active: failing it
			// would invite the sender to retry, which creates a new row and a
			// second run with the same side effects.
			console.warn(
				"[Webhook Trigger] Start unconfirmed; leaving the execution row active:",
				{ executionId: execution.id, workflowId: outcome.workflowId },
				outcome.error,
			);
			// 202 Accepted, not a 5xx: webhook senders retry server errors,
			// and a retry creates a second row and a second run. The body
			// says the start is unconfirmed and names the execution to poll.
			return NextResponse.json(
				{
					success: true,
					status: "unconfirmed",
					executionId: execution.id,
					temporalWorkflowId: outcome.workflowId,
					message: unconfirmedStartMessage(execution.id),
				},
				{ status: 202 },
			);
		}

		// The run exists in the engine from here on. A failure to record that
		// must not be reported as "not started" (the sender would retry and
		// start a second run with the same side effects); it is logged and the
		// start is still reported. The workflow writes its own status as it
		// progresses and its id is deterministic from the execution id.
		// PENDING → RUNNING only: a fast run may already have written its
		// terminal status, which must not move back to RUNNING.
		try {
			await markExecutionRunningIfPending({
				executionId: execution.id,
				temporalRunId: outcome.workflowId,
			});
		} catch (error) {
			console.error(
				"[Webhook Trigger] Run started but the execution row could not be marked RUNNING:",
				{ executionId: execution.id, workflowId: outcome.workflowId },
				error,
			);
		}

		return NextResponse.json({
			success: true,
			executionId: execution.id,
			temporalWorkflowId: outcome.workflowId,
			message: "Workflow triggered successfully",
		});
	} catch (error) {
		console.error("[Webhook Trigger] Error:", error);
		return NextResponse.json(
			{
				error: "Failed to trigger workflow",
				message:
					error instanceof Error ? error.message : "Unknown error",
			},
			{ status: 500 },
		);
	}
}

// GET endpoint for health check / info
export async function GET(_request: NextRequest, { params }: RouteParams) {
	const { workflowId } = await params;

	// Deliberately no `name`. This endpoint is unauthenticated by design — it
	// is the health check a caller hits to see whether the webhook it was
	// given is live — but the id travels inside webhook URLs pasted into
	// third-party systems, so treat it as shared rather than secret. Status,
	// trigger type and published version answer "is this wired up?"; the
	// workflow's name is the one field that leaks something about the
	// workspace and answers nothing.
	const workflow = await db.workflow.findUnique({
		where: { id: workflowId },
		select: {
			id: true,
			status: true,
			triggerType: true,
			publishedVersion: true,
		},
	});

	if (!workflow) {
		return NextResponse.json(
			{ error: "Workflow not found" },
			{ status: 404 },
		);
	}

	return NextResponse.json({
		workflowId: workflow.id,
		status: workflow.status,
		triggerType: workflow.triggerType,
		webhookEnabled: workflow.triggerType === "WEBHOOK",
		publishedVersion: workflow.publishedVersion,
	});
}
