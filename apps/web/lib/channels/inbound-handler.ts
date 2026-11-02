/**
 * Shared channel inbound handler. Used by:
 *   - /api/webhooks/channels/[channel]/events  (unified entry, Slice 5a)
 *   - /api/webhooks/slack/events               (legacy URL, delegates here in 5b.1)
 *
 * Slack apps registered against the legacy URL keep working — they hit the
 * old path which now thin-shims into this handler with channel="slack".
 * No webhook reconfiguration required for existing Slack installs.
 */

import { db, isDeploymentOwnerCurrentMember } from "@repo/database";
import { channelRegistry } from "@repo/integrations";
import {
	addSlackReaction,
	getSlackCredentials,
} from "@repo/integrations/slack";
import { getTemporalClient } from "@repo/temporal";
import { type NextRequest, NextResponse } from "next/server";
import { fanoutSlackMonitorEvent } from "./slack-monitor-fanout";

const THREAD_TIMEOUT_MS = 60 * 60 * 1000; // 1h, mirrors slack default

function lcHeaders(req: NextRequest): Record<string, string> {
	const out: Record<string, string> = {};
	req.headers.forEach((value, key) => {
		out[key.toLowerCase()] = value;
	});
	return out;
}

export async function handleChannelInbound(
	channel: string,
	req: NextRequest,
): Promise<Response> {
	const adapter = channelRegistry.get(channel);
	if (!adapter) {
		return NextResponse.json(
			{ error: `No adapter registered for channel "${channel}"` },
			{ status: 404 },
		);
	}

	const rawBody = await req.text();

	// Verification uses the deployment's own secret, never a tenant's stored
	// connection: nothing in the unauthenticated request can say which
	// tenant it belongs to (Fizzy #2860).
	const verified = await adapter.verifyInbound({
		headers: lcHeaders(req),
		rawBody,
	});

	if (verified.kind === "invalid") {
		console.warn(`[channels:${channel}] verify failed: ${verified.reason}`);
		return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	}

	if (verified.kind === "not_a_message") {
		return NextResponse.json(verified.ack ?? { ok: true });
	}

	const message = verified.message;

	// Dedup — channels retry on non-2xx; the unique index enforces this.
	try {
		await db.channelEventReceipt.create({
			data: { channel, externalEventId: message.externalEventId },
		});
	} catch {
		return NextResponse.json({ ok: true, dedup: true });
	}

	// `slackTeamId` / `slackChannelId` are composed back out of the
	// `channelId` ("teamId/slackChannel") the slack adapter builds; we also
	// accept the team id from the optional `teamId` field on the normalized
	// message when the adapter surfaces it. Hoisted out so both the monitor
	// fanout below and the post-trigger reaction-ack call can reuse them.
	let slackTeamId = "";
	let slackChannelId = message.channelId;
	if (channel === "slack") {
		slackTeamId =
			message.teamId ??
			(() => {
				const slash = message.channelId.indexOf("/");
				return slash >= 0 ? message.channelId.slice(0, slash) : "";
			})();
		slackChannelId = (() => {
			const slash = message.channelId.indexOf("/");
			return slash >= 0
				? message.channelId.slice(slash + 1)
				: message.channelId;
		})();
	}
	const validSlackIds =
		channel !== "slack" ||
		(/^[A-Z0-9]+$/.test(slackTeamId) &&
			/^[A-Z0-9]+$/.test(slackChannelId) &&
			message.channelId === `${slackTeamId}/${slackChannelId}`);

	// Slack channel monitor fanout — runs in parallel with the agent-trigger
	// dispatch path below. We deliberately catch+log here so a monitor outage
	// never blocks trigger delivery (monitor is a passive ingestion feature;
	// triggers are the live conversational path).
	if (channel === "slack") {
		try {
			if (validSlackIds) {
				await fanoutSlackMonitorEvent({
					slackTeamId,
					channelId: slackChannelId,
					externalEventId: message.externalEventId,
					// Prefer the raw Slack `ts` (zero-padded decimal string)
					// surfaced by the adapter so the seen-message dedup table
					// stores a lexicographically-sortable value. Fall back to
					// `occurredAt` ISO when the adapter doesn't expose it.
					ts: message.providerTs ?? message.occurredAt,
					text: message.text,
					sender: message.sender,
					threadId: message.threadId,
					subtype: message.subtype,
					botId: message.botId,
				});
			}
		} catch (err) {
			console.error("[channels:slack] monitor fanout failed", err);
			// Intentional: never block trigger dispatch on monitor failure.
		}
	}

	// Match the inbound message to an AgentDeploymentTrigger (channel +
	// optional chatIdPattern). If no match, persist the mapping for
	// observability but don't dispatch.
	//
	// `messageKind` filter: plain channel posts (Slack `messageKind ===
	// "channel_message"`) ride the monitor fanout path above and must not
	// trigger an agent reply. Only `app_mention` / `direct_message` / undefined
	// (legacy adapters that never set the field) are eligible.
	const isTriggerEligible =
		!message.messageKind ||
		message.messageKind === "app_mention" ||
		message.messageKind === "direct_message";

	const candidates =
		isTriggerEligible && validSlackIds
			? await db.agentDeploymentTrigger.findMany({
					where: {
						isActive: true,
						type: "CHANNEL_MESSAGE",
						...(channel === "slack" ? { slackTeamId } : {}),
					},
					...(channel === "slack"
						? { orderBy: { id: "asc" as const } }
						: {}),
					select: {
						id: true,
						deploymentId: true,
						userId: true,
						organizationId: true,
						config: true,
					},
				})
			: [];
	const matchesChannel = (row: (typeof candidates)[number]) => {
		const cfg = (row.config as Record<string, unknown>) ?? {};
		if (cfg.channel !== channel) {
			return false;
		}
		const pattern = cfg.chatIdPattern;
		if (typeof pattern !== "string" || pattern.length === 0) {
			return true;
		}
		try {
			return new RegExp(pattern).test(message.channelId);
		} catch {
			return false;
		}
	};
	const connectedOwners = new Map<string, boolean>();
	const isConnectedOwner = async (row: (typeof candidates)[number]) => {
		if (!row.userId || !row.organizationId) {
			return false;
		}
		const key = `${row.userId}:${row.organizationId}`;
		if (connectedOwners.has(key)) {
			return connectedOwners.get(key) === true;
		}
		let matches = false;
		try {
			const credentials = await getSlackCredentials(
				row.userId,
				row.organizationId,
				true,
			);
			matches = credentials.teamId === slackTeamId;
		} catch {
			// Missing or unreadable credentials cannot authorize dispatch.
		}
		connectedOwners.set(key, matches);
		return matches;
	};
	let trigger: (typeof candidates)[number] | undefined;
	for (const row of candidates) {
		if (
			matchesChannel(row) &&
			(channel !== "slack" || (await isConnectedOwner(row)))
		) {
			trigger = row;
			break;
		}
	}

	const now = new Date();
	const timeoutAt = new Date(now.getTime() + THREAD_TIMEOUT_MS);
	const where = {
		channel_channelId_threadId: {
			channel,
			channelId: message.channelId,
			threadId: message.threadId,
		},
	};
	const previousMapping =
		channel === "slack" && trigger
			? await db.channelThreadMapping.findUnique({
					where,
					select: { triggerId: true },
				})
			: null;
	const triggerChanged =
		previousMapping !== null && previousMapping.triggerId !== trigger?.id;
	const mapping = await db.channelThreadMapping.upsert({
		where,
		create: {
			channel,
			channelId: message.channelId,
			threadId: message.threadId,
			status: "active",
			lastMessageAt: now,
			timeoutAt,
			userId: trigger?.userId ?? "system",
			organizationId: trigger?.organizationId ?? null,
			triggerId: trigger?.id,
			agentId: trigger?.deploymentId,
		},
		update: {
			status: "active",
			lastMessageAt: now,
			timeoutAt,
			...(triggerChanged ? { workflowId: null } : {}),
			...(trigger
				? {
						userId: trigger.userId ?? "system",
						organizationId: trigger.organizationId ?? null,
						triggerId: trigger.id,
						agentId: trigger.deploymentId,
					}
				: {}),
		},
	});

	// Acknowledge Slack mentions/DMs with an emoji reaction so the user sees an
	// immediate visual signal that the bot received the event:
	//   👀 — matched a trigger and is about to respond
	//   ❌ — addressed the bot but no trigger matched, no reply is coming
	// Fire-and-forget: a missing `reactions:write` scope (stale install) or
	// any other Slack-side error must never block trigger dispatch.
	// Deliberately NOT gated by project Read-only mode: the
	// reaction signals receipt, not content — the reply itself is gated in
	// the post activities.
	if (
		channel === "slack" &&
		isTriggerEligible &&
		validSlackIds &&
		message.providerTs
	) {
		const reactionName = trigger ? "eyes" : "x";
		const reactionOwner =
			trigger ??
			(await (async () => {
				for (const row of candidates) {
					if (await isConnectedOwner(row)) {
						return row;
					}
				}
				return undefined;
			})());
		if (reactionOwner?.userId) {
			void addSlackReaction({
				teamId: slackTeamId,
				channel: slackChannelId,
				timestamp: message.providerTs,
				name: reactionName,
				userId: reactionOwner.userId,
				organizationId: reactionOwner.organizationId ?? undefined,
			}).then((result) => {
				if (!result.ok) {
					console.warn(
						`[channels:slack] reaction:${reactionName} failed`,
						result.error,
					);
				}
			});
		}
	}

	if (!trigger) {
		console.log(
			`[channels:${channel}] mapping ${mapping.id} captured but no matching trigger`,
			{ channelId: message.channelId, threadId: message.threadId },
		);
		return NextResponse.json({
			ok: true,
			mappingId: mapping.id,
			channel,
			channelId: message.channelId,
			threadId: message.threadId,
			dispatched: false,
			reason: "no_matching_trigger",
		});
	}

	const deployment = await db.agentDeployment.findUnique({
		where: { id: trigger.deploymentId },
		select: { userId: true, organizationId: true },
	});
	if (
		!deployment ||
		deployment.userId !== trigger.userId ||
		deployment.organizationId !== trigger.organizationId ||
		!(await isDeploymentOwnerCurrentMember(deployment))
	) {
		return NextResponse.json({
			ok: true,
			mappingId: mapping.id,
			channel,
			channelId: message.channelId,
			threadId: message.threadId,
			dispatched: false,
			reason: "no_matching_trigger",
		});
	}

	const event = {
		externalEventId: message.externalEventId,
		channel,
		channelId: message.channelId,
		threadId: message.threadId,
		text: message.text,
		sender: message.sender,
		isDirect: message.isDirect,
		occurredAt: message.occurredAt,
	};

	const isTimedOut =
		mapping.status !== "active" ||
		(mapping.timeoutAt && mapping.timeoutAt < now);
	const shouldSignalExisting = mapping.workflowId && !isTimedOut;

	const temporalClient = await getTemporalClient();
	let workflowIdUsed: string;

	if (shouldSignalExisting && mapping.workflowId) {
		const handle = temporalClient.workflow.getHandle(mapping.workflowId);
		await handle.signal("channelMessage", event);
		workflowIdUsed = mapping.workflowId;
		console.log(
			`[channels:${channel}] signaled workflow ${workflowIdUsed}`,
		);
	} else {
		workflowIdUsed = `channel-${channel}-${message.channelId}-${message.threadId || "main"}-${Date.now()}`;
		await temporalClient.workflow.start("channelMessageHandlerWorkflow", {
			workflowId: workflowIdUsed,
			taskQueue: "trigger-system",
			args: [
				{
					triggerId: trigger.id,
					deploymentId: trigger.deploymentId,
					channel,
					channelId: message.channelId,
					threadId: message.threadId,
					userId: trigger.userId,
					organizationId: trigger.organizationId ?? undefined,
					// Every agent turn of the thread runs as a background job,
					// on the organization's shared ChatGPT plans when they
					// serve it (Fizzy #2770).
					jobType: "fabric-mention",
				},
			],
		});
		const handle = temporalClient.workflow.getHandle(workflowIdUsed);
		await handle.signal("channelMessage", event);
		await db.channelThreadMapping.update({
			where: { id: mapping.id },
			data: { workflowId: workflowIdUsed },
		});
		console.log(`[channels:${channel}] started workflow ${workflowIdUsed}`);
	}

	return NextResponse.json({
		ok: true,
		mappingId: mapping.id,
		channel,
		channelId: message.channelId,
		threadId: message.threadId,
		dispatched: true,
		workflowId: workflowIdUsed,
	});
}
