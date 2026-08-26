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
import { checkExecutionConcurrency } from "@repo/api/modules/workflows/lib/execution-concurrency";
import {
	WORKFLOW_BUILDER_TASK_QUEUE,
	WORKFLOW_RUN_TIMEOUT,
} from "@repo/api/modules/workflows/lib/execution-limits";
import { db } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
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
		// distributed caller walks straight past it.
		const concurrency = await checkExecutionConcurrency({
			userId: workflow.userId,
			organizationId: workflow.organizationId,
		});

		if (!concurrency.allowed) {
			return NextResponse.json(
				{
					error: "Too many workflow executions in flight",
					message: `This workspace already has ${concurrency.inFlight} workflow executions running (limit ${concurrency.limit}).`,
				},
				{ status: 429, headers: { "Retry-After": "60" } },
			);
		}

		// Create execution record
		const execution = await db.workflowExecution.create({
			data: {
				workflowId,
				// The graph that ran, not the one that was published. Every
				// trigger path executes `workflow.nodes` — the version rows
				// exist for history and rollback — so stamping
				// `publishedVersion` labelled the run with a version whose
				// content was not what executed. Anyone comparing a failed run
				// against "version 3" was reading the wrong graph.
				version: workflow.version,
				status: "PENDING",
				triggerType: "WEBHOOK",
				triggerInput: payload as object,
				userId: workflow.userId,
				organizationId: workflow.organizationId,
			},
		});

		try {
			const temporalClient = await getTemporalClient();
			const handle = await temporalClient.workflow.start(
				"workflowBuilderExecutionWorkflow",
				{
					taskQueue: WORKFLOW_BUILDER_TASK_QUEUE,
					workflowId: `workflow-${execution.id}`,
					// Same runaway ceiling the manual path has. Without it a
					// webhook-triggered run was the one trigger that could hold
					// a worker slot indefinitely.
					workflowExecutionTimeout: WORKFLOW_RUN_TIMEOUT,
					args: [
						{
							workflowId,
							executionId: execution.id,
							nodes: workflow.nodes as object[],
							edges: workflow.edges as object[],
							triggerData: payload,
							userId: workflow.userId,
							organizationId: workflow.organizationId,
						},
					],
				},
			);

			await db.workflowExecution.update({
				where: { id: execution.id },
				data: { temporalRunId: handle.workflowId, status: "RUNNING" },
			});

			return NextResponse.json({
				success: true,
				executionId: execution.id,
				temporalWorkflowId: handle.workflowId,
				message: "Workflow triggered successfully",
			});
		} catch (error) {
			// The row exists but nothing is going to run it, and no sweeper
			// reclaims a PENDING execution. Record the terminal state so the
			// run history says "failed to start" rather than "queued" forever.
			console.error(
				"[Webhook Trigger] Failed to start execution:",
				error,
			);
			const failedAt = new Date();
			await db.workflowExecution.update({
				where: { id: execution.id },
				data: {
					status: "FAILED",
					error:
						error instanceof Error
							? error.message
							: "Failed to start workflow execution",
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
