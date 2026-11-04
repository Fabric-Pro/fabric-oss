import { getAgentImplementationAvailability } from "@repo/agent-types/agent-implementation";
/**
 * Deploy Agent Procedure
 *
 * Creates a deployment from an agent template instance and starts
 * the supervisor workflow for durable execution.
 */

import { randomBytes } from "node:crypto";
import { ORPCError } from "@orpc/server";
import {
	checkDeploymentQuota,
	createAgentDeployment,
	db,
	getAgentDeploymentByInstanceId,
	getAgentTemplateInstance,
	type Prisma,
	setDeploymentSupervisor,
} from "@repo/database";
import { isManagedAgentRunSchedule } from "@repo/database/prisma/queries/lib/managed-agent-run-schedule";
import { getScheduleClient, getTemporalClient } from "@repo/temporal";
import { decryptApiKeyMaybe, encryptApiKey } from "@repo/utils";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";
import {
	buildSlackChannelConfig,
	mapTriggerType,
	resolveBoundSlackIds,
	validateSlackTriggerConfigs,
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
	.use(
		requireInputOrgPermission(Permissions.AGENT_UPDATE, {
			requireOrganization: true,
		}),
	)
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

		if (!organizationId || instance.organizationId !== organizationId) {
			throw new ORPCError("NOT_FOUND", {
				message: "Agent instance not found",
			});
		}

		const availability = getAgentImplementationAvailability(
			instance.customInstructions,
		);
		if (!availability.available) {
			throw new ORPCError("BAD_REQUEST", {
				message: availability.reason,
			});
		}
		await validateSlackTriggerConfigs(instance.triggers, {
			userId: instance.userId,
			organizationId: instance.organizationId,
		});

		// Check if already deployed
		const existingDeployment = await getAgentDeploymentByInstanceId(
			input.instanceId,
			{ userId, organizationId },
		);

		// A saved receipt makes repeated deployment idempotent, including recovery
		// after trigger synchronization failed. It never admits a second supervisor.
		if (
			existingDeployment?.supervisorRunId &&
			existingDeployment.supervisorWorkflowId &&
			["PENDING", "DEPLOYING", "ACTIVE"].includes(
				existingDeployment.status,
			)
		) {
			const activatedTriggers = await activateInstanceTriggers({
				deploymentId: existingDeployment.id,
				supervisorWorkflowId: existingDeployment.supervisorWorkflowId,
				taskQueue: "agents",
				instanceTriggers: instance.triggers as InstanceTrigger[] | null,
				userId,
				organizationId,
				slackOwnerId: instance.userId,
				slackOrganizationId: instance.organizationId,
			});
			return {
				deployment: existingDeployment,
				triggers: activatedTriggers,
			};
		}
		const placeholderDeployment =
			existingDeployment &&
			["PENDING", "DEPLOYING", "ACTIVE"].includes(
				existingDeployment.status,
			) &&
			!existingDeployment.supervisorRunId
				? existingDeployment
				: null;
		if (existingDeployment && !placeholderDeployment) {
			throw new ORPCError("CONFLICT", {
				message:
					"Inspect or terminate the existing deployment before deploying again.",
			});
		}
		const quotaCheck = await checkDeploymentQuota(userId, organizationId);
		// Recovering an already-admitted intent must not create new quota usage.
		if (
			!quotaCheck.allowed &&
			!placeholderDeployment?.supervisorWorkflowId
		) {
			throw new ORPCError("FORBIDDEN", {
				message: quotaCheck.reason || "Deployment quota exceeded",
			});
		}

		// Create deployment record (or reuse the trigger-only placeholder)
		const slug = generateSlug(instance.name);
		const config = input.config;

		const deployment = placeholderDeployment?.supervisorWorkflowId
			? placeholderDeployment
			: placeholderDeployment
				? await db.agentDeployment.update({
						where: { id: placeholderDeployment.id },
						data: {
							name: instance.name,
							maxConcurrentExecutions:
								config?.maxConcurrentExecutions ?? 5,
							rateLimitPerMinute:
								config?.rateLimitPerMinute ?? 60,
							rateLimitPerHour: config?.rateLimitPerHour ?? 500,
							dailyExecutionLimit: config?.dailyExecutionLimit,
							monthlyExecutionLimit:
								config?.monthlyExecutionLimit,
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
		const taskQueue = "agents";
		const workflowId = `agent-supervisor-${deployment.id}`;
		// Persist the admission identity before contacting Temporal. A retry attaches
		// to this same supervisor even if start succeeded but its receipt was lost.
		await db.agentDeployment.update({
			where: { id: deployment.id },
			data: { supervisorWorkflowId: workflowId, taskQueue },
		});

		try {
			// Start supervisor workflow
			const temporalClient = await getTemporalClient();

			const startOptions = withCorrelationMemo({
				taskQueue,
				workflowId,
				workflowIdReusePolicy: "REJECT_DUPLICATE" as const,
				workflowIdConflictPolicy: "FAIL" as const,
				args: [
					{
						deploymentId: deployment.id,
						instanceId: input.instanceId,
						userId,
						organizationId,
						jobType: "external-agent",
						config: {
							maxConcurrentExecutions:
								deployment.maxConcurrentExecutions,
							rateLimitPerMinute: deployment.rateLimitPerMinute,
							rateLimitPerHour: deployment.rateLimitPerHour,
							healthCheckIntervalMs: 60000,
							executionTimeoutMs: 30 * 60 * 1000,
						},
					},
				],
			});
			let runId: string;
			try {
				const handle = await temporalClient.workflow.start(
					"agentSupervisorWorkflow",
					startOptions,
				);
				runId = handle.firstExecutionRunId;
			} catch (error) {
				if (!(error instanceof WorkflowExecutionAlreadyStartedError)) {
					throw error;
				}
				const description = await temporalClient.workflow
					.getHandle(workflowId)
					.describe();
				if (description.status.name !== "RUNNING") {
					throw new ORPCError("CONFLICT", {
						message:
							"The previous supervisor has closed. Inspect its outcome before deploying again.",
					});
				}
				runId = description.runId;
			}

			// Update deployment with workflow info
			await setDeploymentSupervisor(
				deployment.id,
				workflowId,
				runId,
				taskQueue,
			);

			// Receipt and quota are committed atomically and only once.

			// Activate triggers from instance configuration
			const activatedTriggers = await activateInstanceTriggers({
				deploymentId: deployment.id,
				supervisorWorkflowId: workflowId,
				taskQueue,
				instanceTriggers: instance.triggers as InstanceTrigger[] | null,
				userId,
				organizationId,
				slackOwnerId: instance.userId,
				slackOrganizationId: instance.organizationId,
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
			if (error instanceof ORPCError) {
				throw error;
			}
			throw new ORPCError("SERVICE_UNAVAILABLE", {
				message:
					"Deployment admission or receipt is unresolved. Inspect this deployment or retry deployment to reconcile the same supervisor.",
				data: { deploymentId: deployment.id, workflowId },
			});
		}
	});

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
	slackOwnerId: string;
	slackOrganizationId: string | null;
}

/**
 * Activate triggers from instance configuration on deployment
 *
 * Converts instance trigger configs (stored as JSON) to AgentDeploymentTrigger records
 * with generated webhook secrets and URLs.
 * Also creates Temporal schedules for SCHEDULE triggers.
 */
export async function activateInstanceTriggers(
	input: ActivateTriggerInput,
): Promise<ActivatedTrigger[]> {
	const {
		deploymentId,
		supervisorWorkflowId,
		taskQueue,
		instanceTriggers,
		userId,
		organizationId,
		slackOwnerId,
		slackOrganizationId,
	} = input;

	if (!instanceTriggers || instanceTriggers.length === 0) {
		return [];
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
		if (isManagedAgentRunSchedule(row.config)) {
			continue;
		}
		existingByKey.set(triggerKey(row.type, row.slackChannelId), row);
	}
	const seenKeys = new Set<string>();

	const activatedTriggers: ActivatedTrigger[] = [];

	for (const trigger of instanceTriggers) {
		// Skip manual triggers (they don't need activation) and disabled triggers
		if (trigger.type === "manual" || trigger.enabled === false) {
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
			? await resolveBoundSlackIds(
					trigger.config as Record<string, unknown> | undefined,
					{
						userId: slackOwnerId,
						organizationId: slackOrganizationId,
					},
				)
			: { slackChannelId: null, slackTeamId: null };

		const writeConfig: Prisma.InputJsonValue = isSlackInstance
			? buildSlackChannelConfig(
					trigger.config as Record<string, unknown> | undefined,
					slackChannelId,
					slackTeamId,
				)
			: ((trigger.config || {}) as Prisma.InputJsonValue);

		// Slack identifiers were bound to the instance owner's connection.
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
							...(isSlackInstance
								? {
										userId: slackOwnerId,
										organizationId: slackOrganizationId,
									}
								: {}),
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
							userId: isSlackInstance ? slackOwnerId : userId,
							organizationId: isSlackInstance
								? slackOrganizationId
								: organizationId,
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
