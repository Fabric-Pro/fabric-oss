/**
 * Shared channel inbound handler. Used by:
 *   - /api/webhooks/channels/[channel]/events  (unified entry, Slice 5a)
 *   - /api/webhooks/slack/events               (legacy URL, delegates here in 5b.1)
 *
 * Slack apps registered against the legacy URL keep working — they hit the
 * old path which now thin-shims into this handler with channel="slack".
 * No webhook reconfiguration required for existing Slack installs.
 */

import { db } from "@repo/database";
import { channelRegistry } from "@repo/integrations";
import { addSlackReaction } from "@repo/integrations/slack";
import { getTemporalClient } from "@repo/temporal";
import { decryptApiKey } from "@repo/utils";
import { type NextRequest, NextResponse } from "next/server";
import { fanoutSlackMonitorEvent } from "./slack-monitor-fanout";

const THREAD_TIMEOUT_MS = 60 * 60 * 1000; // 1h, mirrors slack default

async function resolveCredentials(
	channel: string,
	providerKey: string,
): Promise<Record<string, unknown> | undefined> {
	type ProviderEnum = NonNullable<
		Parameters<typeof db.workflowIntegration.findFirst>[0]
	>["where"] extends infer W
		? W extends { provider?: infer P }
			? P
			: never
		: never;

	const integration = await db.workflowIntegration.findFirst({
		where: {
			provider: providerKey as unknown as ProviderEnum,
			isActive: true,
		},
		orderBy: { lastUsedAt: "desc" },
	});
	if (!integration) {
		console.warn(
			`[channels:${channel}] no active WorkflowIntegration for provider ${providerKey}`,
		);
		return undefined;
	}
	try {
		return JSON.parse(decryptApiKey(integration.credentials)) as Record<
			string,
			unknown
		>;
	} catch (err) {
		console.error(
			`[channels:${channel}] failed to decrypt credentials`,
			err,
		);
		return undefined;
	}
}

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
	const credentials = await resolveCredentials(channel, adapter.providerKey);

	const verified = await adapter.verifyInbound(
		{ headers: lcHeaders(req), rawBody },
		credentials,
	);

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

	// Slack channel monitor fanout — runs in parallel with the agent-trigger
	// dispatch path below. We deliberately catch+log here so a monitor outage
	// never blocks trigger delivery (monitor is a passive ingestion feature;
	// triggers are the live conversational path).
	if (channel === "slack") {
		try {
			if (slackTeamId) {
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

	const candidates = isTriggerEligible
		? await db.agentDeploymentTrigger.findMany({
				where: { isActive: true, type: "CHANNEL_MESSAGE" },
				select: {
					id: true,
					deploymentId: true,
					userId: true,
					organizationId: true,
					config: true,
				},
			})
		: [];
	const trigger = candidates.find((row) => {
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
	});

	const now = new Date();
	const timeoutAt = new Date(now.getTime() + THREAD_TIMEOUT_MS);
	const where = {
		channel_channelId_threadId: {
			channel,
			channelId: message.channelId,
			threadId: message.threadId,
		},
	};
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
		slackTeamId &&
		message.providerTs
	) {
		const reactionName = trigger ? "eyes" : "x";
		// Bot-token lookup is tenant-scoped on userId; orphan case has no
		// trigger context, so source userId/orgId from any active trigger
		// owned by an installer for this workspace. If none exists or the
		// trigger has no userId we can't resolve a token — skip silently.
		const reactionOwner =
			trigger ??
			(await db.agentDeploymentTrigger.findFirst({
				where: {
					slackTeamId,
					isActive: true,
					userId: { not: null },
				},
				select: { userId: true, organizationId: true },
			}));
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
