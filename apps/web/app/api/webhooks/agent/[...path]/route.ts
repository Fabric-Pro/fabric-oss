/**
 * Agent Webhook Handler
 *
 * Handles incoming webhook requests to trigger agent executions.
 * The path parameter maps to the webhookUrl stored in AgentDeploymentTrigger.
 *
 * Example:
 *   POST /api/webhooks/agent/abc123def456...
 *   → Finds trigger with webhookUrl = "/api/webhooks/agent/abc123def456..."
 *   → Validates signature if required
 *   → Queues execution in Temporal
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { checkExecutionQuota, db, type Prisma } from "@repo/database";
import { type ExecutionRequest, getTemporalClient } from "@repo/temporal";
import { decryptApiKeyMaybe } from "@repo/utils";
import { type NextRequest, NextResponse } from "next/server";

function getTrustedClientIp(request: NextRequest): string | null {
	const trustedHeader = process.env.TRUSTED_PROXY_IP_HEADER?.toLowerCase();

	switch (trustedHeader) {
		case "cf-connecting-ip":
			return request.headers.get("cf-connecting-ip");
		case "x-forwarded-for":
			return (
				request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
				null
			);
		case "x-real-ip":
			return request.headers.get("x-real-ip");
		default:
			return null;
	}
}

/**
 * Verify HMAC signature for authenticated webhooks
 */
function verifySignature(
	payload: string,
	signature: string,
	secret: string,
	timestamp?: string,
): boolean {
	try {
		// If timestamp provided, include it in the signed payload
		const signedPayload = timestamp ? `${timestamp}.${payload}` : payload;

		const expectedSignature = createHmac("sha256", secret)
			.update(signedPayload)
			.digest("hex");

		// Constant-time comparison to prevent timing attacks
		const sigBuffer = Buffer.from(signature);
		const expectedBuffer = Buffer.from(expectedSignature);

		if (sigBuffer.length !== expectedBuffer.length) {
			return false;
		}

		return timingSafeEqual(sigBuffer, expectedBuffer);
	} catch {
		return false;
	}
}

export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ path: string[] }> },
) {
	try {
		const { path } = await params;
		const webhookPath = path.join("/");
		const webhookUrl = `/api/webhooks/agent/${webhookPath}`;

		// Parse request body
		let payload: Record<string, unknown> = {};
		const contentType = request.headers.get("content-type") || "";

		if (contentType.includes("application/json")) {
			try {
				payload = await request.json();
			} catch {
				return NextResponse.json(
					{ error: "Invalid JSON payload" },
					{ status: 400 },
				);
			}
		} else if (contentType.includes("application/x-www-form-urlencoded")) {
			const formData = await request.formData();
			formData.forEach((value, key) => {
				payload[key] = value;
			});
		}

		// Extract signature headers (support multiple formats)
		const signature =
			request.headers.get("x-webhook-signature") ||
			request.headers.get("x-signature-256") ||
			request.headers.get("x-hub-signature-256")?.replace("sha256=", "");

		const timestamp =
			request.headers.get("x-webhook-timestamp") ||
			request.headers.get("x-timestamp");

		// Find the trigger by webhook URL
		const trigger = await db.agentDeploymentTrigger.findFirst({
			where: {
				webhookUrl,
				type: "WEBHOOK",
			},
			include: {
				deployment: true,
			},
		});

		if (!trigger) {
			return NextResponse.json(
				{ error: "Webhook not found" },
				{ status: 404 },
			);
		}

		if (!trigger.isActive) {
			return NextResponse.json(
				{ error: "Webhook is disabled" },
				{ status: 403 },
			);
		}

		// Check if deployment is active
		if (trigger.deployment.status !== "ACTIVE") {
			return NextResponse.json(
				{ error: "Deployment is not active" },
				{ status: 403 },
			);
		}

		// Verify signature if auth is required
		const config = trigger.config as {
			requireAuth?: boolean;
			allowedIps?: string[];
			inputTemplate?: Record<string, unknown>;
			priority?: number;
		} | null;

		if (config?.requireAuth) {
			// Decrypt-with-passthrough: pre-existing plaintext secrets validate
			// unchanged; newly-rotated ones are stored encrypted (SOC 2 CC6.1).
			const webhookSecret = decryptApiKeyMaybe(trigger.webhookSecret);
			if (!signature) {
				return NextResponse.json(
					{ error: "Signature required" },
					{ status: 401 },
				);
			}

			if (!webhookSecret) {
				return NextResponse.json(
					{ error: "Webhook secret is not configured" },
					{ status: 500 },
				);
			}

			if (!timestamp) {
				return NextResponse.json(
					{ error: "Timestamp required" },
					{ status: 401 },
				);
			}

			const payloadString = JSON.stringify(payload);
			const isValid = verifySignature(
				payloadString,
				signature,
				webhookSecret,
				timestamp || undefined,
			);

			if (!isValid) {
				return NextResponse.json(
					{ error: "Invalid signature" },
					{ status: 401 },
				);
			}

			// Verify timestamp is within 5 minutes to prevent replay attacks
			const timestampMs = Number.parseInt(timestamp, 10);
			const now = Date.now();
			const fiveMinutes = 5 * 60 * 1000;

			if (!Number.isFinite(timestampMs)) {
				return NextResponse.json(
					{ error: "Invalid timestamp" },
					{ status: 401 },
				);
			}

			if (Math.abs(now - timestampMs) > fiveMinutes) {
				return NextResponse.json(
					{ error: "Timestamp too old" },
					{ status: 401 },
				);
			}
		}

		// Check IP whitelist if configured
		if (config?.allowedIps && config.allowedIps.length > 0) {
			const clientIp = getTrustedClientIp(request);
			if (!clientIp) {
				return NextResponse.json(
					{
						error: "IP allowlisting requires TRUSTED_PROXY_IP_HEADER to be configured",
					},
					{ status: 500 },
				);
			}

			if (!config.allowedIps.includes(clientIp)) {
				return NextResponse.json(
					{ error: "IP not allowed" },
					{ status: 403 },
				);
			}
		}

		// Check execution quota
		const quotaCheck = await checkExecutionQuota(
			trigger.deploymentId,
			trigger.deployment.userId,
			trigger.deployment.organizationId ?? undefined,
		);

		if (!quotaCheck.allowed) {
			return NextResponse.json(
				{ error: quotaCheck.reason || "Execution quota exceeded" },
				{ status: 429 },
			);
		}

		// Merge input template with webhook payload
		const triggerConfig = trigger.config as { name?: string } | null;
		const executionInput = {
			...(config?.inputTemplate || {}),
			...payload,
			_webhook: {
				triggerId: trigger.id,
				triggerName: triggerConfig?.name || "webhook",
				receivedAt: new Date().toISOString(),
				sourceIp: getTrustedClientIp(request) || "unknown",
			},
		};

		// Create execution record
		const executionId = randomUUID();
		const execution = await db.agentDeploymentExecution.create({
			data: {
				deploymentId: trigger.deploymentId,
				executionId,
				userId: trigger.deployment.userId,
				organizationId: trigger.deployment.organizationId,
				triggerType: "WEBHOOK",
				triggerId: trigger.id,
				input: executionInput as Prisma.InputJsonValue,
				priority: config?.priority ?? 5,
				status: "PENDING",
				queuedAt: new Date(),
			},
		});

		// Update trigger stats
		await db.agentDeploymentTrigger.update({
			where: { id: trigger.id },
			data: {
				lastRunAt: new Date(),
				totalExecutions: { increment: 1 },
				lastExecutionId: execution.id,
			},
		});

		// Signal the supervisor to execute
		if (trigger.deployment.supervisorWorkflowId) {
			const temporalClient = await getTemporalClient();
			const handle = temporalClient.workflow.getHandle(
				trigger.deployment.supervisorWorkflowId,
			);

			const executionRequest: ExecutionRequest = {
				executionId: execution.id,
				input: executionInput,
				triggerType: "WEBHOOK",
				triggerId: trigger.id,
				priority: config?.priority ?? 5,
				queuedAt: new Date().toISOString(),
			};

			await handle.signal("execute", executionRequest);
		}

		return NextResponse.json({
			success: true,
			executionId: execution.id,
			message: "Execution queued",
		});
	} catch (error) {
		console.error("[Webhook] Error handling webhook:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}

// Also support GET for webhook verification (some services require this)
export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ path: string[] }> },
) {
	const { path } = await params;
	const webhookPath = path.join("/");
	const webhookUrl = `/api/webhooks/agent/${webhookPath}`;

	// Find the trigger to verify it exists
	const trigger = await db.agentDeploymentTrigger.findFirst({
		where: {
			webhookUrl,
			type: "WEBHOOK",
		},
	});

	if (!trigger) {
		return NextResponse.json(
			{ error: "Webhook not found" },
			{ status: 404 },
		);
	}

	// Handle webhook verification challenge (for services like Slack)
	const challenge = request.nextUrl.searchParams.get("challenge");
	if (challenge) {
		return NextResponse.json({ challenge });
	}

	return NextResponse.json({
		status: "active",
		triggerId: trigger.id,
	});
}
