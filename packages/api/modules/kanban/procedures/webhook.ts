/**
 * Kanban Webhook Procedure
 *
 * Receives task lifecycle events from fabric-kanban CLI
 * and updates story status in fabric-portal.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { db, updateStory } from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import {
	Permissions,
	publicProcedure,
	requirePermission,
} from "../../../orpc/procedures";
import { enqueuePmSync } from "../../projects/lib/enqueue-pm-sync";

/**
 * Kanban webhook HMAC secret. Fails closed in production (SOC 2 CC6.1): a
 * missing KANBAN_WEBHOOK_SECRET must NOT fall back to a publicly-known
 * "dev-secret" — that would let anyone forge a valid signature and drive story
 * title/status mutations + PM sync. Mirrors getKanbanLaunchTokenSecret() in
 * create-token.ts. The dev fallback is allowed only outside production so the
 * local fabric-kanban CLI keeps working.
 */
function getKanbanWebhookSecret(): string {
	const secret = process.env.KANBAN_WEBHOOK_SECRET;
	if (secret) {
		return secret;
	}
	if (process.env.NODE_ENV === "production") {
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			message:
				"Kanban webhook secret is not configured (set KANBAN_WEBHOOK_SECRET)",
		});
	}
	return "dev-secret";
}

/**
 * Verify webhook signature to ensure it came from kanban
 */
function verifyWebhookSignature(
	payload: string,
	signature: string,
	secret: string,
): boolean {
	try {
		const expectedSignature = createHmac("sha256", secret)
			.update(payload)
			.digest("hex");

		// Timing-safe comparison to prevent timing attacks
		const sigBuf = Buffer.from(signature, "hex");
		const expectedBuf = Buffer.from(expectedSignature, "hex");

		if (sigBuf.length !== expectedBuf.length) {
			return false;
		}

		return timingSafeEqual(sigBuf, expectedBuf);
	} catch {
		return false;
	}
}

/**
 * Webhook endpoint for kanban task events
 */
export const kanbanWebhook = publicProcedure
	.use(requirePermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/kanban/webhook",
		tags: ["Kanban"],
		summary: "Receive task lifecycle events from kanban CLI",
	})
	.input(
		z.object({
			event: z.enum([
				"task.created",
				"task.started",
				"task.completed",
				"task.updated",
				"task.pulled",
			]),
			payload: z.record(z.string(), z.unknown()),
			signature: z.string(),
			timestamp: z.number(),
		}),
	)
	.output(
		z.object({
			success: z.boolean(),
			message: z.string(),
		}),
	)
	.handler(async ({ input }) => {
		// Verify timestamp is within 5 minutes to prevent replay attacks
		const now = Date.now();
		const timestamp = input.timestamp;
		if (Math.abs(now - timestamp) > 5 * 60 * 1000) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Webhook timestamp too old",
			});
		}

		// Verify signature
		const payloadString = JSON.stringify({
			event: input.event,
			payload: input.payload,
			timestamp: input.timestamp,
		});

		if (
			!verifyWebhookSignature(
				payloadString,
				input.signature,
				getKanbanWebhookSecret(),
			)
		) {
			throw new ORPCError("UNAUTHORIZED", {
				message: "Invalid webhook signature",
			});
		}

		// Extract common fields from payload
		const {
			storyId,
			projectId: _projectId,
			...eventData
		} = input.payload as {
			storyId?: string;
			projectId?: string;
			[key: string]: unknown;
		};

		if (!storyId) {
			return {
				success: false,
				message: "Missing storyId in payload",
			};
		}

		// Handle different event types
		switch (input.event) {
			case "task.created": {
				await handleTaskCreated(storyId, eventData);
				break;
			}

			case "task.started": {
				await handleTaskStarted(storyId, eventData);
				break;
			}

			case "task.completed": {
				await handleTaskCompleted(storyId, eventData);
				break;
			}

			case "task.updated": {
				await handleTaskUpdated(storyId, eventData);
				break;
			}

			case "task.pulled": {
				await handleTaskPulled(storyId, eventData);
				break;
			}
		}

		return {
			success: true,
			message: `Processed ${input.event} for story ${storyId}`,
		};
	});

/**
 * Handle task creation event from kanban
 */
async function handleTaskCreated(
	storyId: string,
	data: Record<string, unknown>,
): Promise<void> {
	// Find or create kanban queue entry
	const existing = await db.kanbanQueue.findFirst({
		where: { storyId, status: "PENDING" },
	});

	if (!existing) {
		await db.kanbanQueue.create({
			data: {
				storyId,
				projectId: (data.projectId as string) || "",
				createdById: (data.userId as string) || "",
				status: "PENDING",
				context: data.context as object,
			},
		});
	}
}

/**
 * Handle task started event from kanban
 */
async function handleTaskStarted(
	storyId: string,
	_data: Record<string, unknown>,
): Promise<void> {
	// Update kanban queue entry to PULLED status
	await db.kanbanQueue.updateMany({
		where: { storyId, status: "PENDING" },
		data: {
			status: "PULLED",
			pulledAt: new Date(),
		},
	});
}

/**
 * Handle task completed event from kanban
 */
async function handleTaskCompleted(
	storyId: string,
	data: Record<string, unknown>,
): Promise<void> {
	const {
		commit,
		branch,
		output: _output,
	} = data as {
		commit?: string;
		branch?: string;
		output?: string;
	};

	// Update kanban queue entry to COMPLETED status
	await db.kanbanQueue.updateMany({
		where: { storyId },
		data: {
			status: "COMPLETED",
			completedAt: new Date(),
			branchName: branch,
		},
	});

	// Trigger notification for task completion
	await triggerStoryNotification(storyId, "completed", {
		commit,
		branch,
	});
	// TODO: Update story status to "In Review" or similar
}

/**
 * Trigger notification for story events
 */
async function triggerStoryNotification(
	storyId: string,
	event: string,
	metadata?: Record<string, unknown>,
): Promise<void> {
	// Fetch story details for notification context
	const story = await db.userStory.findUnique({
		where: { id: storyId },
		select: {
			id: true,
			title: true,
			identifier: true,
			projectId: true,
			project: {
				select: {
					name: true,
					organizationId: true,
				},
			},
		},
	});

	if (!story) {
		console.warn(
			`[KanbanWebhook] Story not found for notification: ${storyId}`,
		);
		return;
	}

	// Log notification intent - expand to actual notification delivery later
	console.log("[KanbanWebhook] Triggering notification:", {
		event,
		storyId: story.identifier,
		storyTitle: story.title,
		projectName: story.project.name,
		metadata,
	});

	// TODO: Once notification infrastructure exists, implement actual notification delivery:
	// - Email notifications to story assignee
	// - In-app notifications
	// - Slack/Teams webhooks if configured
	// Example:
	// await notificationService.send({
	//   type: "KANBAN_TASK_COMPLETED",
	//   userId: story.assigneeId,
	//   data: { story, event, metadata }
	// });
}

/**
 * Handle task updated event from kanban
 */
async function handleTaskUpdated(
	storyId: string,
	data: Record<string, unknown>,
): Promise<void> {
	// Handle task updates (title, description, etc.)
	const { title, description } = data as {
		title?: string;
		description?: string;
	};

	if (!title && !description) {
		return;
	}

	const existing = await db.userStory.findUnique({
		where: { id: storyId },
		select: { projectId: true },
	});
	if (!existing) {
		return;
	}
	const updated = await updateStory(
		storyId,
		existing.projectId,
		{
			...(title ? { title } : {}),
			...(description ? { description } : {}),
		},
		{ lastEditedSource: "MANUAL" },
	);

	// kanban-CLI is an upstream developer integration: tasks pulled from
	// Fabric, edited locally, then echoed back via this webhook. When the
	// user has opted into PM auto-sync on the story, propagate the rename
	// onward to the linked PM ticket so all three views (kanban, Fabric,
	// PM tool) converge. Without this the kanban-side rename silently
	// stops at Fabric.
	//
	// Attribution: webhooks have no end-user session, so we credit the
	// story's creator. enqueuePmSync resolves the MCP config under their
	// identity, mirroring the manual-edit path.
	if (updated.pmAutoSyncEnabled) {
		enqueuePmSync({
			itemId: updated.id,
			itemType: "story",
			projectId: updated.projectId,
			userId: updated.createdById,
			triggerSource: "manual-edit",
		}).catch((err) => {
			logger.warn("enqueuePmSync failed", {
				storyId: updated.id,
				err: err instanceof Error ? err.message : String(err),
			});
		});
	}
}

/**
 * Handle task pulled event from kanban
 * When user pulls a task into their kanban from fabric
 */
async function handleTaskPulled(
	storyId: string,
	_data: Record<string, unknown>,
): Promise<void> {
	// Update kanban queue entry to PULLED status
	await db.kanbanQueue.updateMany({
		where: { storyId, status: "PENDING" },
		data: {
			status: "PULLED",
			pulledAt: new Date(),
		},
	});
}
