/**
 * Deploy Agent Procedure
 *
 * Creates a deployment from an agent template instance and starts
 * the supervisor workflow for durable execution.
 */

import { randomBytes } from "node:crypto";
import {
	checkDeploymentQuota,
	createAgentDeployment,
	db,
	getAgentDeploymentByInstanceId,
	getAgentTemplateInstance,
	incrementDeploymentQuota,
	type Prisma,
	setDeploymentSupervisor,
} from "@repo/database";
import { getScheduleClient, getTemporalClient } from "@repo/temporal";
import { decryptApiKeyMaybe, encryptApiKey } from "@repo/utils";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";
import {
	buildSlackChannelConfig,
	mapTriggerType,
	resolveSlackIds,
} from "../lib/sync-triggers";

const deployInputSchema = z.object({
	instanceId: z.string(),
	organizationId: z.string().nullable().optional(),
	config: z
		.object({
			maxConcurrentExecutions: z.number().min(1).max(100).default(5),
			rateLimitPerMinute: z.number().min(1).max(1000).default(60),
			rateLimitPerHour: z.number().min(1).max(10000).default(500),
			dailyExecutionLimit: z.number().min(1).optional(),
			monthlyExecutionLimit: z.number().min(1).optional(),
		})
		.optional(),
});

function generateSlug(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 50);
}

export const deployProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_UPDATE))
	.input(deployInputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify organization membership if deploying to an org
		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				userId,
			);
			if (!membership) {
				throw new Error(
					"You must be a member of the organization to deploy agents",
				);
			}
		}

		// Verify instance exists and user has access
		const instance = await getAgentTemplateInstance(input.instanceId);
		if (!instance) {
			throw new Error("Agent instance not found");
		}

		// Verify ownership/access
		const isOwner = instance.userId === userId;
		const isOrgInstance = instance.organizationId === organizationId;

		if (!isOwner && !isOrgInstance) {
			throw new Error("You don't have access to this agent instance");
		}

		// Check if already deployed
		const existingDeployment = await getAgentDeploymentByInstanceId(
			input.instanceId,
			{ userId, organizationId },
		);

		// Trigger-only flows (Slack mention, lifecycle) create a PENDING
		// placeholder deployment via syncDeploymentTriggers. Treat that row as
		// promotable: the user is now performing a real deploy. A row with a
		// supervisorWorkflowId is genuinely deployed and must be terminated
		// first.
		const placeholderDeployment =
			existingDeployment &&
			existingDeployment.status === "PENDING" &&
			!existingDeployment.supervisorWorkflowId
				? existingDeployment
				: null;

		if (existingDeployment && !placeholderDeployment) {
			if (
				existingDeployment.status === "ACTIVE" ||
				existingDeployment.status === "PAUSED"
			) {
				throw new Error(
					"This agent instance is already deployed. Terminate the existing deployment first.",
				);
			}
		}

		// Check quota
		const quotaCheck = await checkDeploymentQuota(userId, organizationId);
		if (!quotaCheck.allowed) {
			throw new Error(quotaCheck.reason || "Deployment quota exceeded");
		}

		// Create deployment record (or reuse the trigger-only placeholder)
		const slug = generateSlug(instance.name);
		const config = input.config;

		const deployment = placeholderDeployment
			? await db.agentDeployment.update({
					where: { id: placeholderDeployment.id },
					data: {
						name: instance.name,
						maxConcurrentExecutions:
							config?.maxConcurrentExecutions ?? 5,
						rateLimitPerMinute: config?.rateLimitPerMinute ?? 60,
						rateLimitPerHour: config?.rateLimitPerHour ?? 500,
						dailyExecutionLimit: config?.dailyExecutionLimit,
						monthlyExecutionLimit: config?.monthlyExecutionLimit,
					},
					include: {
						instance: { include: { template: true } },
					},
				})
			: await createAgentDeployment({
					instanceId: input.instanceId,
					userId,
					organizationId,
					name: instance.name,
					slug: `${slug}-${Date.now()}`,
					maxConcurrentExecutions:
						config?.maxConcurrentExecutions ?? 5,
					rateLimitPerMinute: config?.rateLimitPerMinute ?? 60,
					rateLimitPerHour: config?.rateLimitPerHour ?? 500,
					dailyExecutionLimit: config?.dailyExecutionLimit,
					monthlyExecutionLimit: config?.monthlyExecutionLimit,
				});

		// Select task queue based on user/org context
		const taskQueue = selectTaskQueueForDeployment(userId, organizationId);

		try {
			// Start supervisor workflow
			const temporalClient = await getTemporalClient();

			const workflowId = `agent-supervisor-${deployment.id}`;
			const handle = await temporalClient.workflow.start(
				"agentSupervisorWorkflow",
				withCorrelationMemo({
					taskQueue,
					workflowId,
					args: [
						{
							deploymentId: deployment.id,
							instanceId: input.instanceId,
							userId,
							organizationId,
							config: {
								maxConcurrentExecutions:
									deployment.maxConcurrentExecutions,
								rateLimitPerMinute:
									deployment.rateLimitPerMinute,
								rateLimitPerHour: deployment.rateLimitPerHour,
								healthCheckIntervalMs: 60000, // 1 minute
								executionTimeoutMs: 30 * 60 * 1000, // 30 minutes
							},
						},
					],
				}),
			);

			// Update deployment with workflow info
			await setDeploymentSupervisor(
				deployment.id,
				workflowId,
				handle.firstExecutionRunId,
				taskQueue,
			);

			// Increment quota
			await incrementDeploymentQuota(userId, organizationId);

			// Activate triggers from instance configuration
			const activatedTriggers = await activateInstanceTriggers({
				deploymentId: deployment.id,
				supervisorWorkflowId: workflowId,
				taskQueue,
				instanceTriggers: instance.triggers as InstanceTrigger[] | null,
				userId,
				organizationId,
			});

			return {
				deployment: {
					...deployment,
					supervisorWorkflowId: workflowId,
					taskQueue,
				},
				triggers: activatedTriggers,
			};
		} catch (error) {
			// Clean up on failure - mark deployment as failed
			// This would be handled by a compensation in production
			throw new Error(
				`Failed to start supervisor workflow: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	});

/**
 * Select task queue based on tenant context
 */
function selectTaskQueueForDeployment(
	userId: string,
	organizationId?: string,
): string {
	// Simple hash-based sharding
	const hashCode = (str: string): number => {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash = hash & hash;
		}
		return Math.abs(hash);
	};

	if (organizationId) {
		// Organization: use shared pool with 10 shards
		const shardNumber = hashCode(organizationId) % 10;
		return `agents-org-shared-shard-${shardNumber}`;
	}

	// Personal: use personal pool with 5 shards
	const shardNumber = hashCode(userId) % 5;
	return `agents-personal-shard-${shardNumber}`;
}

// =============================================================================
// TRIGGER ACTIVATION
// =============================================================================

/**
 * Instance trigger configuration (stored on AgentTemplateInstance)
 */
interface InstanceTrigger {
	type: "manual" | "schedule" | "webhook" | "slack" | "lifecycle";
	enabled?: boolean;
	config?: {
		cron?: string;
		timezone?: string;
		channel?: string;
		channelId?: string;
		slackChannelId?: string;
		teamId?: string;
		workspaceId?: string;
		slackTeamId?: string;
		mentionOnly?: boolean;
		customPath?: string;
		resource?: string;
		event?: string;
		conditions?: Record<string, unknown>;
	};
}

/**
 * Activated trigger result
 */
interface ActivatedTrigger {
	id: string;
	type: string;
	isActive: boolean;
	webhookUrl?: string | null;
	webhookSecret?: string | null;
	cronExpression?: string | null;
	timezone?: string | null;
}

/**
 * Check if an integration is configured for the user/organization.
 *
 * TENANT ISOLATION NOTE: This function intentionally uses an OR pattern to check
 * if credentials exist at EITHER the organization level OR the user's personal level.
 * This is a credential discovery/fallback mechanism, NOT a data query:
 * - In org context: First check for org-level Slack integration, fallback to user's personal
 * - In personal context: Only check user's personal Slack integration
 *
 * This OR pattern is SAFE here because:
 * 1. We're only checking for credential EXISTENCE (boolean result), not returning data
 * 2. The user must have access to use those credentials (they own them or are in the org)
 * 3. No sensitive data is leaked - just whether integration is configured
 */
async function isIntegrationConfigured(
	provider: "SLACK" | string,
	userId: string,
	organizationId?: string,
): Promise<boolean> {
	// Only check known providers
	if (provider !== "SLACK") {
		// Unknown provider, assume not required
		return true;
	}

	// Check for workflow integration credentials with fallback
	// In org context: org-level credentials OR user's personal credentials
	// In personal context: user's personal credentials only
	const integration = await db.workflowIntegration.findFirst({
		where: {
			provider: "SLACK",
			OR: organizationId
				? [{ organizationId }, { userId, organizationId: null }]
				: [{ userId, organizationId: null }],
		},
		select: { id: true },
	});

	return integration !== null;
}

/**
 * Generate webhook secret for trigger authentication
 */
function generateWebhookSecret(): string {
	return randomBytes(32).toString("hex");
}

/**
 * Generate unique webhook URL path
 */
function generateWebhookUrl(): string {
	const path = randomBytes(16).toString("hex");
	return `/api/webhooks/agent/${path}`;
}

/**
 * Input for activating instance triggers
 */
interface ActivateTriggerInput {
	deploymentId: string;
	supervisorWorkflowId: string;
	taskQueue: string;
	instanceTriggers: InstanceTrigger[] | null;
	userId: string;
	organizationId?: string;
}

/**
 * Activate triggers from instance configuration on deployment
 *
 * Converts instance trigger configs (stored as JSON) to AgentDeploymentTrigger records
 * with generated webhook secrets and URLs.
 * Also creates Temporal schedules for SCHEDULE triggers.
 */
async function activateInstanceTriggers(
	input: ActivateTriggerInput,
): Promise<ActivatedTrigger[]> {
	const {
		deploymentId,
		supervisorWorkflowId,
		taskQueue,
		instanceTriggers,
		userId,
		organizationId,
	} = input;

	if (!instanceTriggers || instanceTriggers.length === 0) {
		return [];
	}

	// Check Slack integration if any Slack triggers are present
	const hasSlackTriggers = instanceTriggers.some(
		(t) => t.type === "slack" && t.enabled !== false,
	);
	let slackIntegrationConfigured = false;

	if (hasSlackTriggers) {
		slackIntegrationConfigured = await isIntegrationConfigured(
			"SLACK",
			userId,
			organizationId,
		);
		if (!slackIntegrationConfigured) {
			console.warn(
				`[Deploy] Slack triggers requested but Slack integration not configured for deployment ${deploymentId}`,
			);
		}
	}

	// Pre-load any existing trigger rows so we can reconcile rather than
	// duplicate. syncDeploymentTriggers may have already created rows for the
	// instance (placeholder PENDING deployment path); the @@unique constraint
	// catches Slack collisions but lifecycle/webhook/schedule rows have a null
	// slackChannelId and Postgres treats nulls as distinct, so naive create()
	// would silently insert duplicates and dispatchLifecycleEvent would match
	// twice.
	const existingTriggerRows = await db.agentDeploymentTrigger.findMany({
		where: { deploymentId },
	});
	const existingByKey = new Map<
		string,
		(typeof existingTriggerRows)[number]
	>();
	const triggerKey = (type: string, slackChannelId: string | null) =>
		`${type}:${slackChannelId ?? ""}`;
	for (const row of existingTriggerRows) {
		existingByKey.set(triggerKey(row.type, row.slackChannelId), row);
	}
	const seenKeys = new Set<string>();

	const activatedTriggers: ActivatedTrigger[] = [];

	for (const trigger of instanceTriggers) {
		// Skip manual triggers (they don't need activation) and disabled triggers
		if (trigger.type === "manual" || trigger.enabled === false) {
			continue;
		}

		// Skip Slack triggers if integration not configured (with warning)
		if (trigger.type === "slack" && !slackIntegrationConfigured) {
			console.warn(
				`[Deploy] Skipping Slack trigger for deployment ${deploymentId} - integration not configured`,
			);
			continue;
		}

		// Map instance trigger type to deployment trigger type
		const deploymentType = mapTriggerType(trigger.type);
		if (!deploymentType) {
			continue;
		}

		// Generate webhook-specific fields
		const isWebhook = deploymentType === "WEBHOOK";
		const webhookUrl = isWebhook ? generateWebhookUrl() : null;
		const webhookSecret = isWebhook ? generateWebhookSecret() : null;

		// Extract cron expression for schedule triggers
		const cronExpression =
			deploymentType === "SCHEDULE" ? trigger.config?.cron || null : null;
		const timezone = trigger.config?.timezone || "UTC";
		const isSlackInstance = trigger.type.toLowerCase() === "slack";
		const { slackChannelId, slackTeamId } = isSlackInstance
			? resolveSlackIds(
					trigger.config as Record<string, unknown> | undefined,
				)
			: { slackChannelId: null, slackTeamId: null };

		const writeConfig: Prisma.InputJsonValue = isSlackInstance
			? buildSlackChannelConfig(
					trigger.config as Record<string, unknown> | undefined,
					slackChannelId,
					slackTeamId,
				)
			: ((trigger.config || {}) as Prisma.InputJsonValue);

		// teamId is the tenant boundary for Slack — see sync-triggers.ts for
		// the full reasoning. Without it the trigger is unscoped and we
		// mark the row inactive until the user reconfigures.
		const writeIsActive = isSlackInstance ? Boolean(slackTeamId) : true;

		try {
			const key = triggerKey(deploymentType, slackChannelId ?? null);
			seenKeys.add(key);
			const existing = existingByKey.get(key);

			// Reuse the existing row if syncDeploymentTriggers already created
			// it for the placeholder. Preserve webhookUrl/webhookSecret so
			// external callers don't break across a deploy.
			const upserted = existing
				? await db.agentDeploymentTrigger.update({
						where: { id: existing.id },
						data: {
							config: writeConfig,
							isActive: writeIsActive,
							cronExpression,
							timezone,
							slackChannelId,
							slackTeamId,
						},
					})
				: await db.agentDeploymentTrigger.create({
						data: {
							deploymentId,
							type: deploymentType,
							config: writeConfig,
							isActive: writeIsActive,
							webhookUrl,
							webhookSecret: webhookSecret
								? encryptApiKey(webhookSecret)
								: null,
							cronExpression,
							timezone,
							slackChannelId,
							slackTeamId,
							userId,
							organizationId,
						},
					});

			// Always ensure the Temporal schedule exists for SCHEDULE triggers.
			// Placeholder rows from syncDeploymentTriggers have a trigger row
			// but no Temporal schedule; createTemporalSchedule is idempotent
			// (skips when the schedule already exists) so calling it on every
			// promote/redeploy is safe.
			if (deploymentType === "SCHEDULE" && cronExpression) {
				await createTemporalSchedule({
					triggerId: upserted.id,
					deploymentId,
					supervisorWorkflowId,
					taskQueue,
					cronExpression,
					timezone,
				});
			}

			activatedTriggers.push({
				id: upserted.id,
				type: upserted.type,
				isActive: upserted.isActive,
				webhookUrl: upserted.webhookUrl,
				// Return the usable plaintext secret (decrypt-with-passthrough
				// handles both the freshly-encrypted create and a preserved row).
				webhookSecret: decryptApiKeyMaybe(upserted.webhookSecret),
				cronExpression: upserted.cronExpression,
				timezone: upserted.timezone,
			});
		} catch (error) {
			console.error(
				`Failed to create trigger ${trigger.type} for deployment ${deploymentId}:`,
				error,
			);
		}
	}

	// Deactivate any pre-existing rows that aren't represented in the latest
	// instance config (e.g. user removed a trigger before promoting).
	for (const [key, row] of existingByKey) {
		if (seenKeys.has(key) || !row.isActive) {
			continue;
		}
		try {
			await db.agentDeploymentTrigger.update({
				where: { id: row.id },
				data: { isActive: false },
			});
		} catch (error) {
			console.error(
				`[Deploy] Failed to deactivate stale trigger ${row.id}:`,
				error,
			);
		}
	}

	return activatedTriggers;
}

// =============================================================================
// TEMPORAL SCHEDULE MANAGEMENT
// =============================================================================

interface CreateScheduleInput {
	triggerId: string;
	deploymentId: string;
	supervisorWorkflowId: string;
	taskQueue: string;
	cronExpression: string;
	timezone: string;
}

/**
 * Validate cron expression
 */
function validateCronExpression(cronExpression: string): {
	valid: boolean;
	error?: string;
} {
	try {
		// Use cron-parser to validate
		CronExpressionParser.parse(cronExpression);
		return { valid: true };
	} catch (error) {
		return {
			valid: false,
			error:
				error instanceof Error
					? error.message
					: "Invalid cron expression",
		};
	}
}

/**
 * Create a Temporal schedule for a SCHEDULE trigger
 *
 * The schedule will signal the supervisor workflow to execute at the specified cron intervals.
 * Idempotent: if a schedule with the same id already exists, the call returns
 * without creating a duplicate. Needed because the deploy path may re-call
 * this when promoting a placeholder trigger row that pre-existed without a
 * schedule.
 */
async function createTemporalSchedule(
	input: CreateScheduleInput,
): Promise<void> {
	const {
		triggerId,
		deploymentId,
		supervisorWorkflowId,
		taskQueue,
		cronExpression,
		timezone,
	} = input;

	// Validate cron expression
	const validation = validateCronExpression(cronExpression);
	if (!validation.valid) {
		console.error(
			`Invalid cron expression for trigger ${triggerId}: ${validation.error}`,
		);
		throw new Error(`Invalid cron expression: ${validation.error}`);
	}

	const scheduleId = `trigger-schedule-${triggerId}`;

	try {
		const scheduleClient = await getScheduleClient();

		// Skip create if the schedule already exists. describe() throws
		// NotFoundError when the schedule is missing — that's the path that
		// falls through to create.
		try {
			await scheduleClient.getHandle(scheduleId).describe();
			console.log(
				`[Deploy] Temporal schedule ${scheduleId} already exists, skipping create`,
			);
			return;
		} catch {
			// Schedule does not exist; proceed to create.
		}

		// Create the schedule
		// The schedule will signal the supervisor workflow with an execution request
		await scheduleClient.create({
			scheduleId,
			spec: {
				// Convert 5-part cron to 6-part (add seconds)
				cronExpressions: [
					cronExpression.trim().split(/\s+/).length === 5
						? `0 ${cronExpression}`
						: cronExpression,
				],
				timezone,
			},
			action: {
				type: "startWorkflow",
				// We use a lightweight trigger workflow that signals the supervisor
				workflowType: "scheduleTriggerWorkflow",
				taskQueue,
				args: [
					{
						supervisorWorkflowId,
						deploymentId,
						triggerId,
						triggerType: "SCHEDULE",
					},
				],
				workflowId: `sched-trigger-${triggerId}-${Date.now()}`,
			},
			policies: {
				// Overlap policy: SKIP means if the previous execution is still running, skip this one
				overlap: "SKIP",
				// Catchup window: How far back to catch up missed schedules
				catchupWindow: "1 minute",
			},
			state: {
				paused: false,
				note: `Schedule trigger for deployment ${deploymentId}`,
			},
		});

		console.log(
			`[Deploy] Created Temporal schedule ${scheduleId} for trigger ${triggerId}`,
		);
	} catch (error) {
		console.error(
			`Failed to create Temporal schedule for trigger ${triggerId}:`,
			error,
		);
		// Don't throw - we've already created the trigger record
		// The schedule can be recreated manually or on next deployment
	}
}
