/**
 * Teams Events API Webhook Handler
 *
 * Handles incoming Microsoft Teams bot events for conversational agent interactions.
 * Implements thread continuity with workflow signaling/starting.
 *
 * Features:
 * - Simple token verification (initial Teams bot setup)
 * - @mention event filtering
 * - Tenant isolation via ProjectLinkedTeamsChannel
 * - Thread continuity via SlackThreadMapping (with teams platform prefix)
 * - Bot/self filtering
 * - Workflow signaling or starting based on thread state
 *
 * Events processed:
 * - message with mention: @Fabric mentions in channels or chats
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { type NextRequest, NextResponse } from "next/server";

// Environment variables
const TEAMS_VERIFICATION_TOKEN =
	process.env.TEAMS_WEBHOOK_VERIFICATION_TOKEN || "";
const TEAMS_BOT_SIGNING_SECRET = process.env.TEAMS_BOT_SIGNING_SECRET || "";
const TEAMS_EVENTS_RATE_LIMIT_PER_MINUTE = Number(
	process.env.TEAMS_EVENTS_RATE_LIMIT_PER_MINUTE || "60",
);

/**
 * Teams Activity payload structure
 */
interface TeamsActivity {
	type: string;
	id: string;
	timestamp?: string;
	localTimestamp?: string;
	serviceUrl?: string;
	channelId?: string;
	from?: {
		id?: string;
		name?: string;
		aadObjectId?: string;
	};
	conversation?: {
		id?: string;
		conversationType?: "channel" | "personal" | "group";
		tenantId?: string;
		name?: string;
	};
	recipient?: {
		id?: string;
		name?: string;
	};
	text?: string;
	textFormat?: string;
	entities?: Array<{
		type: string;
		mentioned?: {
			id?: string;
			name?: string;
		};
		text?: string;
	}>;
	channelData?: {
		team?: {
			id?: string;
		};
		channel?: {
			id?: string;
		};
		tenant?: {
			id?: string;
		};
	};
	value?: Record<string, unknown>;
}

/**
 * Clean mention text by removing @bot mention tags
 */
function cleanMentionText(
	text: string,
	entities?: TeamsActivity["entities"],
): string {
	if (!entities) {
		return text.trim();
	}

	let cleaned = text;
	for (const entity of entities) {
		if (entity.type === "mention" && entity.text) {
			cleaned = cleaned.replace(entity.text, "");
		}
	}
	return cleaned.trim();
}

/**
 * Verify HMAC-SHA256 signature for Teams Bot Framework
 * Defense-in-depth: verifies the request body integrity using a signing secret
 */
function verifyTeamsSignature(
	payload: string,
	signature: string,
	secret: string,
): boolean {
	try {
		const expected = createHmac("sha256", secret).update(payload).digest();
		const provided = Buffer.from(signature, "hex");
		if (provided.length !== expected.length) {
			return false;
		}
		return timingSafeEqual(provided, expected);
	} catch {
		return false;
	}
}

/**
 * POST handler for Teams bot events
 */
export async function POST(request: NextRequest) {
	try {
		// Get raw body
		const rawBody = await request.text();

		// Fail closed in deployed environments (SOC 2 CC6.1): if NEITHER a
		// signing secret NOR a verification token is configured, both checks
		// below are skipped and this endpoint would accept unauthenticated
		// events. Vercel sets NODE_ENV=production on every deployment (staging
		// and prod), so reject there; allow the bypass only in local dev.
		if (!TEAMS_BOT_SIGNING_SECRET && !TEAMS_VERIFICATION_TOKEN) {
			if (process.env.NODE_ENV === "production") {
				console.error(
					"[Teams Events] No signing secret or verification token configured — rejecting (fail-closed)",
				);
				return NextResponse.json(
					{ error: "Webhook authentication not configured" },
					{ status: 401 },
				);
			}
			console.warn(
				"[Teams Events] No webhook auth configured — dev bypass (local only)",
			);
		}

		// HMAC signature verification (defense-in-depth)
		if (TEAMS_BOT_SIGNING_SECRET) {
			const signature = request.headers.get("x-teams-signature") || "";
			if (!signature) {
				console.warn("[Teams Events] Missing HMAC signature");
				return NextResponse.json(
					{ error: "Missing HMAC signature" },
					{ status: 401 },
				);
			}
			if (
				!verifyTeamsSignature(
					rawBody,
					signature,
					TEAMS_BOT_SIGNING_SECRET,
				)
			) {
				console.warn("[Teams Events] Invalid HMAC signature");
				return NextResponse.json(
					{ error: "Invalid HMAC signature" },
					{ status: 401 },
				);
			}
		}

		// Simple token verification (fallback when HMAC is not configured)
		const authHeader = request.headers.get("authorization") || "";
		const verificationToken =
			request.headers.get("x-teams-verification-token") || "";

		if (TEAMS_VERIFICATION_TOKEN) {
			const providedToken =
				verificationToken || authHeader.replace("Bearer ", "");
			if (providedToken !== TEAMS_VERIFICATION_TOKEN) {
				console.warn("[Teams Events] Invalid verification token");
				return NextResponse.json(
					{ error: "Invalid verification token" },
					{ status: 401 },
				);
			}
		}

		// Parse payload
		let activity: TeamsActivity;
		try {
			activity = JSON.parse(rawBody);
		} catch {
			return NextResponse.json(
				{ error: "Invalid JSON" },
				{ status: 400 },
			);
		}

		// Handle URL verification / invoke activities (Bot Framework setup)
		if (
			activity.type === "invoke" ||
			activity.type === "conversationUpdate"
		) {
			console.log(
				"[Teams Events] Setup activity received:",
				activity.type,
			);
			return NextResponse.json({
				status: 200,
				body: { type: "message", text: "Bot is ready" },
			});
		}

		// Only process message activities
		if (activity.type !== "message") {
			return NextResponse.json({ ok: true });
		}

		// Check for mentions
		const hasMention = activity.entities?.some((e) => e.type === "mention");

		if (
			!hasMention &&
			activity.conversation?.conversationType === "channel"
		) {
			// In channels, only process mentions
			console.log(
				"[Teams Events] Ignoring non-mention message in channel",
			);
			return NextResponse.json({ ok: true, ignored: true });
		}

		// Skip messages from the bot itself
		if (
			activity.from?.id &&
			activity.recipient?.id &&
			activity.from.id === activity.recipient.id
		) {
			console.log("[Teams Events] Ignoring bot self-message");
			return NextResponse.json({ ok: true, filtered: true });
		}

		// Extract conversation identifiers
		const conversationId = activity.conversation?.id || "";
		const teamId = activity.channelData?.team?.id || "";
		const channelId = activity.channelData?.channel?.id || conversationId;
		const tenantId = activity.channelData?.tenant?.id || "";

		// Extract message details
		const text = activity.text || "";
		const cleanedText = cleanMentionText(text, activity.entities);
		const fromId = activity.from?.id || "unknown";
		const fromName = activity.from?.name || "Teams User";
		const messageId = activity.id;

		console.log("[Teams Events] Processing message:", {
			messageId,
			teamId,
			channelId,
			conversationType: activity.conversation?.conversationType,
			fromName,
			hasText: cleanedText.length > 0,
			hasMention,
		});

		if (!cleanedText) {
			return NextResponse.json({ ok: true, empty: true });
		}

		// Rate limiting: create a receipt record and count actual events per channel
		const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
		const channelKey = channelId || conversationId;

		// Idempotency: Teams retries the same activity.id on transient failure.
		// createMany + skipDuplicates lets us detect a duplicate (count === 0)
		// and return early before signalling workflows again.
		try {
			const insertResult = await db.teamsEventReceipt.createMany({
				data: [
					{
						teamsEventId: messageId,
						channelId: channelKey,
						teamId: teamId || null,
						messageId,
						userId: null, // updated after linkedChannel lookup
						organizationId: null,
					},
				],
				skipDuplicates: true,
			});

			if (insertResult.count === 0) {
				console.log("[Teams Events] Duplicate event ignored:", {
					messageId,
				});
				return NextResponse.json({ ok: true, duplicate: true });
			}

			// Sample-based cleanup: at ~2% of requests, delete receipts older
			// than 24h for this channel. Running on every webhook adds a
			// per-request DELETE that the rate-limit count window (1 min)
			// doesn't need.
			if (Math.random() < 0.02) {
				const twentyFourHoursAgo = new Date(
					Date.now() - 24 * 60 * 60 * 1000,
				);
				const { count } = await db.teamsEventReceipt.deleteMany({
					where: {
						channelId: channelKey,
						receivedAt: { lt: twentyFourHoursAgo },
					},
				});
				if (count > 0) {
					console.log("[Teams Events] Cleaned up old receipts", {
						count,
						channelKey,
					});
				}
			}
		} catch (err) {
			console.warn("[Teams Events] Receipt insert failed:", {
				messageId,
				err,
			});
		}

		// Count actual event receipts for this channel in the last minute
		const recentReceiptCount = await db.teamsEventReceipt.count({
			where: {
				channelId: channelKey,
				receivedAt: { gte: oneMinuteAgo },
			},
		});
		if (recentReceiptCount >= TEAMS_EVENTS_RATE_LIMIT_PER_MINUTE) {
			console.warn("[Teams Events] Rate limit exceeded:", {
				channelId: channelKey,
				recentReceiptCount,
				limit: TEAMS_EVENTS_RATE_LIMIT_PER_MINUTE,
			});
			return NextResponse.json(
				{ error: "Rate limit exceeded" },
				{ status: 429 },
			);
		}

		// Look up the linked channel by exact channelId / conversationId match
		// only. Matching on teamId alone can return another project's row when
		// multiple projects connect to the same Teams team — violates tenant
		// XOR. The tenantId guard below is defense-in-depth, not the primary
		// gate.
		const channelCandidates = Array.from(
			new Set([channelId, conversationId].filter(Boolean)),
		);
		const linkedChannel = channelCandidates.length
			? await db.projectLinkedTeamsChannel.findFirst({
					where: { channelId: { in: channelCandidates } },
					include: { project: true },
				})
			: null;

		if (!linkedChannel) {
			console.log("[Teams Events] No linked channel found:", {
				channelId,
				conversationId,
				teamId,
			});
			return NextResponse.json({ ok: true, noChannel: true });
		}

		// Tenant isolation validation
		if (!linkedChannel.userId && !linkedChannel.organizationId) {
			console.error(
				"[Teams Events] Linked channel missing tenant context:",
				{
					linkedChannelId: linkedChannel.id,
				},
			);
			return NextResponse.json(
				{ error: "Channel misconfiguration" },
				{ status: 403 },
			);
		}

		if (linkedChannel.tenantId && linkedChannel.tenantId !== tenantId) {
			console.warn("[Teams Events] Tenant ID mismatch:", {
				linkedChannelId: linkedChannel.id,
				expectedTenantId: linkedChannel.tenantId,
				incomingTenantId: tenantId,
			});
			return NextResponse.json(
				{ error: "Tenant mismatch" },
				{ status: 403 },
			);
		}

		const project = linkedChannel.project;
		const userId = linkedChannel.userId || project.userId;
		const organizationId =
			linkedChannel.organizationId || project.organizationId;

		// Backfill tenant info on the receipt now that we know the user/org
		try {
			await db.teamsEventReceipt.updateMany({
				where: { teamsEventId: messageId, userId: null },
				data: {
					userId,
					organizationId: organizationId ?? null,
				},
			});
		} catch {
			// Non-critical: receipt already exists or update failed
		}

		if (!userId) {
			console.error("[Teams Events] No userId found for linked channel");
			return NextResponse.json(
				{ error: "No user context found" },
				{ status: 500 },
			);
		}

		// Find an active agent deployment for this user/org
		const deployment = await db.agentDeployment.findFirst({
			where: {
				userId,
				organizationId: organizationId ?? null,
				status: {
					in: ["ACTIVE", "PENDING"],
				},
			},
			orderBy: {
				createdAt: "desc",
			},
			select: {
				id: true,
			},
		});

		if (!deployment) {
			console.log("[Teams Events] No active deployment found:", {
				userId,
				organizationId,
			});
			return NextResponse.json({ ok: true, noDeployment: true });
		}

		// Thread identity: use conversationId as the thread identifier
		const threadId = conversationId || messageId;

		// Check for existing thread mapping
		const compositeTeamId = `teams:${teamId || "personal"}`;
		const compositeChannelId = `teams:${channelId || conversationId}`;

		let mapping = await db.slackThreadMapping.findFirst({
			where: {
				slackTeamId: compositeTeamId,
				slackChannelId: compositeChannelId,
				slackThreadTs: threadId,
				userId,
				organizationId: organizationId ?? null,
			},
		});

		const temporalClient = await getTemporalClient();
		const now = new Date();
		const timeoutAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

		if (!mapping) {
			// Create new thread mapping
			mapping = await db.slackThreadMapping.create({
				data: {
					slackTeamId: compositeTeamId,
					slackChannelId: compositeChannelId,
					slackThreadTs: threadId,
					deploymentId: deployment.id,
					status: "active",
					timeoutAt,
					userId,
					organizationId: organizationId ?? null,
					contextJson: {
						platform: "teams",
						teamId,
						channelId,
						conversationId,
						tenantId,
						createdAt: now.toISOString(),
					},
				},
			});

			console.log("[Teams Events] Created new thread mapping:", {
				mappingId: mapping.id,
			});
		} else {
			// Update existing mapping
			mapping = await db.slackThreadMapping.update({
				where: { id: mapping.id },
				data: {
					status: "active",
					timeoutAt,
				},
			});

			console.log("[Teams Events] Updated existing thread mapping:", {
				mappingId: mapping.id,
				workflowId: mapping.workflowId,
			});
		}

		// Check if we should signal existing workflow or start new one
		const isTimedOut =
			mapping.status !== "active" ||
			(mapping.timeoutAt && mapping.timeoutAt < now);

		const shouldSignalExisting = mapping.workflowId && !isTimedOut;

		const mentionSignalPayload = {
			eventId: messageId,
			teamId: teamId || "personal",
			channelId: channelId || conversationId,
			chatId:
				activity.conversation?.conversationType !== "channel"
					? conversationId
					: undefined,
			messageId,
			threadId,
			user: { id: fromId, name: fromName },
			text: cleanedText,
			ts: activity.timestamp || new Date().toISOString(),
			isMention: hasMention,
		};

		if (shouldSignalExisting) {
			console.log("[Teams Events] Signaling existing workflow:", {
				mappingId: mapping.id,
				workflowId: mapping.workflowId,
			});

			if (!mapping.workflowId) {
				return NextResponse.json(
					{ error: "Workflow mapping is missing workflowId" },
					{ status: 500 },
				);
			}

			const handle = temporalClient.workflow.getHandle(
				mapping.workflowId,
			);

			await handle.signal("teamsMention", mentionSignalPayload);

			console.log("[Teams Events] Workflow signaled successfully:", {
				workflowId: mapping.workflowId,
				mappingId: mapping.id,
			});

			return NextResponse.json({
				ok: true,
				eventId: messageId,
				mappingId: mapping.id,
				action: "signal_existing",
				workflowId: mapping.workflowId,
			});
		}

		// Start new workflow
		console.log("[Teams Events] Starting new workflow:", {
			mappingId: mapping.id,
			reason: isTimedOut ? "timeout" : "new_thread",
		});

		const workflowId = `teams-thread-${teamId || "personal"}-${channelId || conversationId}-${Date.now()}`;

		await temporalClient.workflow.start("teamsMentionHandlerWorkflow", {
			workflowId,
			taskQueue: "trigger-system",
			args: [
				{
					deploymentId: deployment.id,
					teamId: teamId || "personal",
					channelId: channelId || conversationId,
					userId,
					organizationId: organizationId ?? undefined,
				},
			],
		});

		// Update mapping with new workflowId
		await db.slackThreadMapping.update({
			where: { id: mapping.id },
			data: {
				workflowId,
			},
		});

		// Signal the first message to the new workflow
		const handle = temporalClient.workflow.getHandle(workflowId);
		await handle.signal("teamsMention", mentionSignalPayload);

		console.log("[Teams Events] New workflow started and signaled:", {
			workflowId,
			mappingId: mapping.id,
			teamId,
			channelId,
		});

		return NextResponse.json({
			ok: true,
			eventId: messageId,
			mappingId: mapping.id,
			action: "start_new",
			workflowId,
		});
	} catch (error) {
		console.error("[Teams Events] Error processing event:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}

/**
 * GET handler for webhook verification / health check
 */
export async function GET() {
	return NextResponse.json({
		status: "ok",
		service: "Fabric Teams Events API",
		version: "1.0",
		features: [
			"mentions",
			"rate_limiting",
			"tenant_validation",
			"hmac_verification",
			"receipt_cleanup",
		],
	});
}
