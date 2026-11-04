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
import { isManagedAgentRunSchedule } from "@repo/database/prisma/queries/lib/managed-agent-run-schedule";
import { getSlackCredentials } from "@repo/integrations/slack";
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

const SLACK_ID = /^[A-Z0-9]+$/;

export async function resolveBoundSlackIds(
	config: Record<string, unknown> | undefined,
	owner: { userId: string; organizationId: string | null | undefined },
): Promise<{ slackChannelId: string | null; slackTeamId: string }> {
	if (!owner.organizationId) {
		throw new Error("Slack triggers require an organization");
	}
	const c = config ?? {};
	const hasId = (value: unknown) =>
		value !== undefined &&
		value !== null &&
		!(typeof value === "string" && value.trim() === "");
	const channelIds = [c.channelId, c.slackChannelId].filter(hasId);
	const teamIds = [c.teamId, c.workspaceId, c.slackTeamId].filter(hasId);
	for (const id of [...channelIds, ...teamIds]) {
		if (typeof id !== "string" || !SLACK_ID.test(id)) {
			throw new Error(
				"Slack team ID and channel ID must contain only uppercase letters and digits",
			);
		}
	}
	if (new Set(channelIds).size > 1 || new Set(teamIds).size > 1) {
		throw new Error("Slack trigger identifiers disagree");
	}
	let connectedTeamId: string | undefined;
	try {
		connectedTeamId = (
			await getSlackCredentials(owner.userId, owner.organizationId, true)
		).teamId;
	} catch {
		throw new Error(
			"The agent owner's Slack connection is missing or could not be verified; check the owner's connection and try again",
		);
	}
	if (!connectedTeamId || !SLACK_ID.test(connectedTeamId)) {
		throw new Error(
			"The agent owner's Slack connection has no readable team ID; ask the owner to reconnect Slack",
		);
	}
	if (teamIds.length > 0 && teamIds[0] !== connectedTeamId) {
		throw new Error(
			"The agent owner's Slack connection points to a different workspace than this trigger",
		);
	}
	return {
		slackTeamId: connectedTeamId,
		slackChannelId: (channelIds[0] as string | undefined) ?? null,
	};
}

export async function assertPersistedSlackTriggerBinding(row: {
	userId: string | null;
	organizationId: string | null;
	slackTeamId: string | null;
	slackChannelId: string | null;
	config: unknown;
}): Promise<void> {
	if (
		!row.userId ||
		!row.organizationId ||
		!row.slackTeamId ||
		!row.config ||
		typeof row.config !== "object" ||
		Array.isArray(row.config)
	) {
		throw new Error("Slack trigger owner or configuration is unavailable");
	}
	const config = row.config as Record<string, unknown>;
	const channelId =
		config.channelId ?? config.slackChannelId ?? row.slackChannelId;
	const bound = await resolveBoundSlackIds(
		{ ...config, channelId },
		{
			userId: row.userId,
			organizationId: row.organizationId,
		},
	);
	const expectedPattern = bound.slackChannelId
		? `^${bound.slackTeamId}/${bound.slackChannelId}$`
		: `^${bound.slackTeamId}/`;
	if (
		row.slackTeamId !== bound.slackTeamId ||
		row.slackChannelId !== bound.slackChannelId ||
		config.chatIdPattern !== expectedPattern
	) {
		throw new Error("Slack trigger does not match the connected workspace");
	}
}

export async function validateSlackTriggerConfigs(
	triggers: unknown,
	owner: { userId: string; organizationId: string | null | undefined },
): Promise<void> {
	if (!Array.isArray(triggers)) {
		return;
	}
	for (const trigger of triggers) {
		if (trigger?.type !== "slack" || trigger.enabled === false) {
			continue;
		}
		if (
			trigger.config != null &&
			(typeof trigger.config !== "object" ||
				Array.isArray(trigger.config))
		) {
			throw new Error("Invalid Slack trigger configuration");
		}
		await resolveBoundSlackIds(trigger.config, owner);
	}
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
	if (
		!slackTeamId ||
		!SLACK_ID.test(slackTeamId) ||
		(slackChannelId !== null && !SLACK_ID.test(slackChannelId))
	) {
		throw new Error("Invalid Slack team or channel ID");
	}
	const config: Record<string, unknown> = {
		...(original ?? {}),
		channel: "slack",
		teamId: slackTeamId,
	};
	config.chatIdPattern = slackChannelId
		? `^${slackTeamId}/${slackChannelId}$`
		: `^${slackTeamId}/`;
	// The caller must bind teamId to the owner's connection before activation.
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
		select: {
			id: true,
			name: true,
			triggers: true,
			userId: true,
			organizationId: true,
		},
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
	await validateSlackTriggerConfigs(enabled, {
		userId: instance.userId,
		organizationId: instance.organizationId,
	});

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
				userId: instance.userId,
				organizationId: instance.organizationId,
			});

	const existingRows = await db.agentDeploymentTrigger.findMany({
		where: { deploymentId },
	});
	const existingByKey = new Map<string, (typeof existingRows)[number]>();
	for (const row of existingRows) {
		if (isManagedAgentRunSchedule(row.config)) {
			continue;
		}
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
			? await resolveBoundSlackIds(config, {
					userId: instance.userId,
					organizationId: instance.organizationId,
				})
			: { slackChannelId: null, slackTeamId: null };
		const cronExpression =
			deploymentType === "SCHEDULE" ? (config.cron ?? null) : null;
		const timezone = config.timezone ?? "UTC";

		const writeConfig: Prisma.InputJsonValue = isSlackInstance
			? buildSlackChannelConfig(config, slackChannelId, slackTeamId)
			: ((config ?? {}) as Prisma.InputJsonValue);

		// A Slack row reaches this point only after its team is bound to the
		// owner's active connection and its identifiers pass validation.
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
						...(isSlackInstance
							? {
									userId: instance.userId,
									organizationId: instance.organizationId,
								}
							: {}),
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
						userId: isSlackInstance
							? instance.userId
							: input.userId,
						organizationId: instance.organizationId,
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
