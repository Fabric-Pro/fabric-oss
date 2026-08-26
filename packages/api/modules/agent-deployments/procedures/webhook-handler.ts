/**
 * Webhook Handler
 *
 * Handles incoming webhook requests to trigger agent executions.
 * This is a public endpoint that validates the webhook secret.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
	checkExecutionQuota,
	db,
	incrementInstanceRunCount,
	type Prisma,
} from "@repo/database";
import type { ExecutionRequest } from "@repo/temporal";
import { getTemporalClient } from "@repo/temporal";
import { decryptApiKeyMaybe } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	publicProcedure,
	requirePermission,
} from "../../../orpc/procedures";

const webhookInputSchema = z.object({
	webhookUrl: z.string(),
	payload: z.record(z.string(), z.unknown()).optional(),
	signature: z.string().optional(),
	timestamp: z.string().optional(),
});

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

export const handleWebhookProcedure = publicProcedure
	.use(requirePermission(Permissions.AGENT_EXECUTE))
	.input(webhookInputSchema)
	.handler(async ({ input }) => {
		// Find the trigger by webhook URL
		const trigger = await db.agentDeploymentTrigger.findFirst({
			where: {
				webhookUrl: input.webhookUrl,
				type: "WEBHOOK",
			},
			include: {
				deployment: true,
			},
		});

		if (!trigger) {
			throw new Error("Webhook not found");
		}

		if (!trigger.isActive) {
			throw new Error("Webhook is disabled");
		}

		// Check if deployment is active
		if (trigger.deployment.status !== "ACTIVE") {
			throw new Error("Deployment is not active");
		}

		// Verify signature if auth is required
		const config = trigger.config as {
			requireAuth?: boolean;
			allowedIps?: string[];
			inputTemplate?: Record<string, unknown>;
			priority?: number;
		};

		if (config.requireAuth) {
			if (!input.signature) {
				throw new Error("Signature required");
			}
			if (!input.timestamp) {
				throw new Error("Timestamp required");
			}

			const payloadString = JSON.stringify(input.payload || {});
			const isValid = verifySignature(
				payloadString,
				input.signature,
				// biome-ignore lint/style/noNonNullAssertion: webhookSecret exists on triggers with webhooks
				decryptApiKeyMaybe(trigger.webhookSecret!),
				input.timestamp,
			);

			if (!isValid) {
				throw new Error("Invalid signature");
			}

			// Verify timestamp is within 5 minutes to prevent replay attacks
			const timestampMs = Number.parseInt(input.timestamp, 10);
			const now = Date.now();
			const fiveMinutes = 5 * 60 * 1000;

			if (!Number.isFinite(timestampMs)) {
				throw new Error("Invalid timestamp");
			}

			if (Math.abs(now - timestampMs) > fiveMinutes) {
				throw new Error("Timestamp too old");
			}
		}

		if (config.allowedIps?.length) {
			throw new Error(
				"IP allowlisting is only supported via the direct webhook HTTP endpoint",
			);
		}

		// Check execution quota
		const quotaCheck = await checkExecutionQuota(
			trigger.deploymentId,
			trigger.deployment.userId,
			trigger.deployment.organizationId ?? undefined,
		);

		if (!quotaCheck.allowed) {
			throw new Error(quotaCheck.reason || "Execution quota exceeded");
		}

		// Merge input template with webhook payload
		const triggerConfig = trigger.config as { name?: string } | null;
		const executionInput = {
			...(config.inputTemplate || {}),
			...(input.payload || {}),
			_webhook: {
				triggerId: trigger.id,
				triggerName: triggerConfig?.name || "webhook",
				receivedAt: new Date().toISOString(),
			},
		};

		// Create execution record directly
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
				priority: config.priority ?? 5,
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

		// Increment the agent template instance run count
		await incrementInstanceRunCount(trigger.deployment.instanceId);

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
				priority: config.priority ?? 5,
				queuedAt: new Date().toISOString(),
			};

			await handle.signal("execute", executionRequest);
		}

		return {
			success: true,
			executionId: execution.id,
			message: "Execution queued",
		};
	});
