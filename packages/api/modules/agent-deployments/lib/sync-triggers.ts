/**
 * Sync Deployment Triggers
 *
 * Idempotently reconciles AgentDeploymentTrigger rows with the trigger config
 * stored on an AgentTemplateInstance. Used by the agent create/update flows so
 * that toggling a trigger in the UI immediately makes it routable (e.g. Slack
 * mentions hit the right deployment without a separate "deploy" step).
 *
 * Behavior:
 * - Creates an AgentDeployment row if none exists and at least one non-manual
 *   trigger is enabled. The supervisor workflow is intentionally NOT started
 *   here — that's still the job of `deployProcedure` for manual/scheduled
 *   execution paths. Slack and lifecycle triggers don't need it.
 * - For each enabled trigger, upserts a matching AgentDeploymentTrigger row.
 *   Preserves webhookSecret/webhookUrl across re-saves so external callers
 *   don't break.
 * - Marks rows as `isActive = false` for triggers that were removed or
 *   disabled in the latest save.
 */

import { randomBytes } from "node:crypto";
import { type DeploymentTriggerType, db, type Prisma } from "@repo/database";
import { encryptApiKey } from "@repo/utils";

interface InstanceTriggerConfig {
	cron?: string;
	timezone?: string;
	channelId?: string;
	slackChannelId?: string;
	teamId?: string;
	workspaceId?: string;
	slackTeamId?: string;
	botUserId?: string;
	mentionOnly?: boolean;
	customPath?: string;
	resource?: string;
	event?: string;
	conditions?: Record<string, unknown>;
	[key: string]: unknown;
}

interface InstanceTrigger {
	type: "manual" | "schedule" | "webhook" | "slack" | "lifecycle";
	enabled?: boolean;
	config?: InstanceTriggerConfig;
}

export interface SyncDeploymentTriggersInput {
	instanceId: string;
	userId: string;
	organizationId?: string | null;
}

export function mapTriggerType(
	instanceType: string,
): DeploymentTriggerType | null {
	switch (instanceType.toLowerCase()) {
		case "webhook":
			return "WEBHOOK";
		case "slack":
			// Slice 5b.2 unified Slack onto the ChannelAdapter pipeline. The
			// inbound handler (apps/web/lib/channels/inbound-handler.ts) and the
			// temporal trigger-system activity both filter by CHANNEL_MESSAGE +
			// `config.channel`, so the legacy SLACK enum is now an orphan label.
			return "CHANNEL_MESSAGE";
		case "schedule":
			return "SCHEDULE";
		case "lifecycle":
		case "lifecycle_event":
			return "LIFECYCLE_EVENT";
		default:
			return null;
	}
}

export function resolveSlackIds(config: Record<string, unknown> | undefined): {
	slackChannelId: string | null;
	slackTeamId: string | null;
} {
	const c = (config ?? {}) as Record<string, unknown>;
	return {
		slackChannelId: (c.channelId ?? c.slackChannelId ?? null) as
			| string
			| null,
		slackTeamId: (c.teamId ?? c.workspaceId ?? c.slackTeamId ?? null) as
			| string
			| null,
	};
}

/**
 * Build the JSON `config` blob written to AgentDeploymentTrigger for a Slack
 * channel-message trigger. Injects the `channel` discriminator and a
 * `chatIdPattern` regex derived from teamId/channelId. The inbound handler
 * matches `message.channelId` (shaped as `${teamId}/${slackChannelId}`)
 * against this pattern.
 */
export function buildSlackChannelConfig(
	original: Record<string, unknown> | undefined,
	slackChannelId: string | null,
	slackTeamId: string | null,
): Prisma.InputJsonValue {
	const config: Record<string, unknown> = {
		...(original ?? {}),
		channel: "slack",
	};
	if (slackTeamId) {
		config.chatIdPattern = slackChannelId
			? `^${slackTeamId}/${slackChannelId}$`
			: `^${slackTeamId}/`;
	}
	// teamId is the tenant boundary; without it we deliberately omit
	// chatIdPattern and the caller marks the trigger inactive.
	return config as Prisma.InputJsonValue;
}

function generateWebhookSecret(): string {
	return randomBytes(32).toString("hex");
}

function generateWebhookUrl(): string {
	const path = randomBytes(16).toString("hex");
	return `/api/webhooks/agent/${path}`;
}

function generateSlug(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

// Composite key matching the @@unique([deploymentId, type, slackChannelId])
// constraint in the Prisma schema. slackChannelId is nullable, so we coerce
// `null` to an empty string in the key only.
function triggerKey(
	type: DeploymentTriggerType,
	slackChannelId: string | null,
): string {
	return `${type}:${slackChannelId ?? ""}`;
}

async function ensureDeployment(input: {
	instanceId: string;
	instanceName: string;
	userId: string;
	organizationId?: string | null;
}): Promise<string> {
	const existing = await db.agentDeployment.findUnique({
		where: { instanceId: input.instanceId },
		select: { id: true },
	});
	if (existing) {
		return existing.id;
	}

	const baseSlug = generateSlug(input.instanceName) || "agent";
	const slug = `${baseSlug}-${Date.now()}`;
	const created = await db.agentDeployment.create({
		data: {
			instanceId: input.instanceId,
			userId: input.userId,
			organizationId: input.organizationId ?? null,
			name: input.instanceName,
			slug,
			// PENDING (not ACTIVE) — taskQueue / supervisorWorkflowId are null,
			// so this row is only a routing anchor for trigger-only paths
			// (Slack mentions, lifecycle events). `deployProcedure` blocks
			// re-deploys when status is ACTIVE/PAUSED, so leaving this PENDING
			// lets the user still complete a real deployment that promotes it.
			status: "PENDING",
		},
		select: { id: true },
	});
	return created.id;
}

/**
 * Reconcile AgentDeploymentTrigger rows for an agent instance.
 *
 * Reads the latest `triggers` JSON off the instance and upserts rows to match.
 * Safe to call multiple times; failures during a single trigger row do not
 * roll back others.
 */
export async function syncDeploymentTriggers(
	input: SyncDeploymentTriggersInput,
): Promise<void> {
	const instance = await db.agentTemplateInstance.findUnique({
		where: { id: input.instanceId },
		select: { id: true, name: true, triggers: true },
	});
	if (!instance) {
		return;
	}

	const rawTriggers = (instance.triggers ?? []) as unknown as
		| InstanceTrigger[]
		| null;
	const triggers = Array.isArray(rawTriggers) ? rawTriggers : [];

	const enabled = triggers.filter(
		(t) => t.enabled !== false && t.type !== "manual",
	);

	const existingDeployment = await db.agentDeployment.findUnique({
		where: { instanceId: input.instanceId },
		select: { id: true },
	});

	// Skip work entirely when nothing is enabled and no deployment exists yet.
	if (!existingDeployment && enabled.length === 0) {
		return;
	}

	const deploymentId = existingDeployment
		? existingDeployment.id
		: await ensureDeployment({
				instanceId: instance.id,
				instanceName: instance.name,
				userId: input.userId,
				organizationId: input.organizationId,
			});

	const existingRows = await db.agentDeploymentTrigger.findMany({
		where: { deploymentId },
	});
	const existingByKey = new Map<string, (typeof existingRows)[number]>();
	for (const row of existingRows) {
		existingByKey.set(triggerKey(row.type, row.slackChannelId), row);
	}

	const seen = new Set<string>();

	for (const trigger of enabled) {
		const deploymentType = mapTriggerType(trigger.type);
		if (!deploymentType) {
			continue;
		}

		const config = trigger.config ?? {};
		const isSlackInstance = trigger.type.toLowerCase() === "slack";
		const { slackChannelId, slackTeamId } = isSlackInstance
			? resolveSlackIds(config)
			: { slackChannelId: null, slackTeamId: null };
		const cronExpression =
			deploymentType === "SCHEDULE" ? (config.cron ?? null) : null;
		const timezone = config.timezone ?? "UTC";

		const writeConfig: Prisma.InputJsonValue = isSlackInstance
			? buildSlackChannelConfig(config, slackChannelId, slackTeamId)
			: ((config ?? {}) as Prisma.InputJsonValue);

		// teamId is the tenant boundary for Slack — without it any
		// chatIdPattern we synthesize would risk matching events from
		// unrelated workspaces. Without a pattern the matcher treats the row
		// as a wildcard and dispatches every Slack event to this trigger.
		// Either way the safe move is to mark the row inactive until the
		// user reconfigures it.
		const writeIsActive = isSlackInstance ? Boolean(slackTeamId) : true;

		const key = triggerKey(deploymentType, slackChannelId ?? null);
		seen.add(key);

		const found = existingByKey.get(key);
		try {
			if (found) {
				await db.agentDeploymentTrigger.update({
					where: { id: found.id },
					data: {
						config: writeConfig,
						cronExpression,
						timezone,
						slackChannelId: slackChannelId ?? null,
						slackTeamId: slackTeamId ?? null,
						isActive: writeIsActive,
					},
				});
			} else {
				const isWebhook = deploymentType === "WEBHOOK";
				await db.agentDeploymentTrigger.create({
					data: {
						deploymentId,
						type: deploymentType,
						config: writeConfig,
						isActive: writeIsActive,
						webhookUrl: isWebhook ? generateWebhookUrl() : null,
						webhookSecret: isWebhook
							? encryptApiKey(generateWebhookSecret())
							: null,
						cronExpression,
						timezone,
						slackChannelId: slackChannelId ?? null,
						slackTeamId: slackTeamId ?? null,
						userId: input.userId,
						organizationId: input.organizationId ?? null,
					},
				});
			}
		} catch (error) {
			console.error(
				`[syncDeploymentTriggers] Failed to upsert ${deploymentType} trigger for deployment ${deploymentId}:`,
				error,
			);
		}
	}

	// Deactivate any existing rows that aren't represented in the latest save.
	for (const [key, row] of existingByKey) {
		if (seen.has(key) || !row.isActive) {
			continue;
		}
		try {
			await db.agentDeploymentTrigger.update({
				where: { id: row.id },
				data: { isActive: false },
			});
		} catch (error) {
			console.error(
				`[syncDeploymentTriggers] Failed to deactivate stale trigger ${row.id}:`,
				error,
			);
		}
	}
}
