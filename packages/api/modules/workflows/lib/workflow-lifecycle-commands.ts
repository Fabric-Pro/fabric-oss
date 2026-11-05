import { db, isWorkflowLive, Prisma, recordAudit } from "@repo/database";
import { logger } from "@repo/logs";
import {
	buildWorkflowScheduleId,
	getScheduleClient,
	isPlausibleCron,
	isValidScheduleTimeZone,
	ScheduleNotFoundError,
} from "@repo/temporal";
import { findAgenticPublishProblems } from "./agentic-publish-validation";
import { commitWorkflowVersion } from "./commit-workflow-version";
import {
	workflowIdentitySchema,
	workflowPublishSchema,
	workflowRollbackSchema,
	workflowScheduleSchema,
	workflowVersionsSchema,
} from "./lifecycle-contracts";
import { syncWorkflowSchedule } from "./sync-workflow-schedule";
import {
	loadEditableWorkflow,
	loadReadableWorkflow,
	type WorkflowActor,
	WorkflowCommandError,
} from "./workflow-command-context";
import {
	applyWorkflowUpdateWithSchedule,
	pauseWorkflowCommand,
	publishWorkflowCommand,
	resumeWorkflowCommand,
	unpublishWorkflowCommand,
} from "./workflow-commands";
import { describeWorkflowSchedule } from "./workflow-schedule-description";
import { workflowScheduleMatches } from "./workflow-schedule-match";
import { validateWorkflowBeforeExecution } from "./workflow-validation";

const WEBHOOK_SCHEDULE_MESSAGE =
	"This workflow starts from a webhook. Duplicate it to create a scheduled workflow.";
function usesWebhook(workflow: {
	triggerType: string;
	nodes: unknown;
}): boolean {
	return (
		workflow.triggerType === "WEBHOOK" ||
		(Array.isArray(workflow.nodes) &&
			workflow.nodes.some(
				(node) =>
					node &&
					node.type === "trigger" &&
					String(
						node.data?.config?.triggerType ?? "",
					).toLowerCase() === "webhook",
			))
	);
}
export async function rollbackWorkflowCommand(
	actor: WorkflowActor,
	raw: unknown,
) {
	const { workflowId, targetVersion } = workflowRollbackSchema.parse(raw);
	const workflow = await loadEditableWorkflow(actor, workflowId, "publish");
	// Find the target version
	const targetVersionData = await db.workflowVersion.findFirst({
		where: {
			workflowId,
			version: targetVersion,
			userId: actor.userId,
			organizationId: actor.organizationId,
			isPublished: true,
		},
	});

	if (!targetVersionData) {
		throw new WorkflowCommandError(
			"NOT_FOUND",
			`Version ${targetVersion} not found`,
		);
	}

	// Restoring an older published graph cannot bypass today's publish gates.
	const nodes = Array.isArray(targetVersionData.nodes)
		? targetVersionData.nodes
		: [];
	const edges = Array.isArray(targetVersionData.edges)
		? targetVersionData.edges
		: [];
	const validation = validateWorkflowBeforeExecution(nodes, edges);
	if (!validation.valid) {
		throw new WorkflowCommandError(
			"BAD_REQUEST",
			validation.errors.join("; "),
		);
	}
	const { problems } = await findAgenticPublishProblems({
		nodes,
		userId: workflow.userId,
		organizationId: workflow.organizationId,
		projectId: workflow.projectId ?? null,
	});
	if (!validation.valid || problems.length > 0) {
		throw new WorkflowCommandError(
			"BAD_REQUEST",
			[...validation.errors, ...problems].join("; "),
		);
	}

	const content = {
		nodes: targetVersionData.nodes ?? {},
		edges: targetVersionData.edges ?? {},
		variables: targetVersionData.variables ?? undefined,
		settings: workflow.settings ?? undefined,
		triggerConfig: targetVersionData.triggerConfig ?? undefined,
	};
	const newVersion = await commitWorkflowVersion({
		operation: "rollback",
		workflowId,
		userId: actor.userId,
		organizationId: actor.organizationId,
		expectedUpdatedAt: workflow.updatedAt,
		publishedAt: new Date(),
		changelog: `Rollback to version ${targetVersion}`,
		content,
		patch: {
			nodes: content.nodes,
			edges: content.edges,
			variables: targetVersionData.variables ?? Prisma.JsonNull,
			triggerConfig: targetVersionData.triggerConfig ?? Prisma.JsonNull,
		},
	});

	// Rollback replaces the node graph, and the cron lives on the graph's
	// trigger node — so the schedule that was live a moment ago may no
	// longer match what the workflow now says. Publish and unpublish both
	// sync; without this, rolling back to a different (or absent) cron
	// leaves the previous schedule firing against the new definition.
	// A draft is left alone: its schedule is created when it is published.
	const scheduleActive = isWorkflowLive(workflow.status);
	const schedule = await syncWorkflowSchedule({
		workflowId,
		nodes: targetVersionData.nodes,
		userId: workflow.userId,
		organizationId: workflow.organizationId,
		projectId: workflow.projectId,
		workflowName: workflow.name,
		active: scheduleActive,
	});

	return {
		success: true as const,
		schedule,
		version: newVersion,
		message: `Workflow rolled back to version ${targetVersion} (now version ${newVersion})`,
	};
}
export async function listWorkflowVersionsCommand(
	actor: WorkflowActor,
	raw: unknown,
) {
	const input = workflowVersionsSchema.parse(raw);
	await loadReadableWorkflow(actor, input.workflowId);
	const where = {
		workflowId: input.workflowId,
		userId: actor.userId,
		organizationId: actor.organizationId,
	};
	const [versions, total] = await Promise.all([
		db.workflowVersion.findMany({
			where,
			orderBy: { version: "desc" },
			take: input.limit,
			skip: input.offset,
			select: {
				id: true,
				version: true,
				changelog: true,
				isPublished: true,
				publishedAt: true,
				createdBy: true,
				createdAt: true,
			},
		}),
		db.workflowVersion.count({ where }),
	]);
	return { versions, total };
}
export async function getWorkflowScheduleCommand(
	actor: WorkflowActor,
	raw: unknown,
) {
	const { workflowId } = workflowIdentitySchema.parse(raw);
	const workflow = await loadReadableWorkflow(actor, workflowId);
	const snapshot = workflow.publishedAt
		? await db.workflowVersion.findFirst({
				where: {
					workflowId,
					userId: actor.userId,
					organizationId: actor.organizationId,
					version: workflow.publishedVersion ?? workflow.version,
					isPublished: true,
				},
				select: { nodes: true },
			})
		: null;
	const draft = describeWorkflowSchedule(workflow.nodes);
	const published = snapshot
		? describeWorkflowSchedule(snapshot.nodes)
		: null;
	const expectedActive =
		isWorkflowLive(workflow.status) && published !== null;
	const base = {
		configurationIssue: usesWebhook(workflow)
			? WEBHOOK_SCHEDULE_MESSAGE
			: null,
		workflowId,
		status: workflow.status,
		draft,
		published,
		publishRequired: JSON.stringify(draft) !== JSON.stringify(published),
		nextRunAt: null as string | null,
	};
	try {
		const client = await getScheduleClient();
		const schedule = await client
			.getHandle(buildWorkflowScheduleId(workflowId))
			.describe();
		const matches = published
			? workflowScheduleMatches(schedule.spec, published)
			: false;
		return {
			...base,
			state: expectedActive
				? matches === false
					? "out-of-sync"
					: matches === null
						? "unverified"
						: schedule.state.paused
							? "paused"
							: "active"
				: "out-of-sync",
			nextRunAt: schedule.info.nextActionTimes[0]?.toISOString() ?? null,
		};
	} catch (error) {
		if (error instanceof ScheduleNotFoundError) {
			return { ...base, state: expectedActive ? "missing" : "inactive" };
		}
		const code =
			error && typeof error === "object" && "code" in error
				? error.code
				: undefined;
		const failureKind =
			code === 7 || code === 16
				? "authorization"
				: code === 4
					? "timeout"
					: code === 14 || code === "ECONNREFUSED"
						? "unavailable"
						: "unexpected";
		logger.warn(
			{
				failureKind,
				event: "workflow.schedule.describe_failed",
				workflowId,
				organizationId: actor.organizationId,
			},
			"Could not inspect workflow schedule",
		);
		return { ...base, state: "unavailable" };
	}
}
/** Saves a draft only. Publishing remains the deliberate activation step. */
export async function configureWorkflowScheduleCommand(
	actor: WorkflowActor,
	raw: unknown,
) {
	const input = workflowScheduleSchema.parse(raw);
	if (
		!isPlausibleCron(input.cron) ||
		!isValidScheduleTimeZone(input.timezone)
	) {
		throw new WorkflowCommandError(
			"BAD_REQUEST",
			"Use a valid cron expression and IANA time zone.",
		);
	}
	const workflow = await loadEditableWorkflow(
		actor,
		input.workflowId,
		"edit",
	);
	if (usesWebhook(workflow))
		throw new WorkflowCommandError("BAD_REQUEST", WEBHOOK_SCHEDULE_MESSAGE);
	if (!Array.isArray(workflow.nodes)) {
		throw new WorkflowCommandError(
			"BAD_REQUEST",
			"Add a trigger before configuring a schedule.",
		);
	}
	const nodes = structuredClone(workflow.nodes) as {
		id: string;
		type?: string;
		data?: { config?: Record<string, unknown> };
	}[];
	const triggers = nodes.filter((n) => n?.type === "trigger");
	if (triggers.length !== 1) {
		throw new WorkflowCommandError(
			"BAD_REQUEST",
			"Choose a workflow with exactly one trigger.",
		);
	}
	const trigger = triggers[0];
	trigger.data ??= {};
	trigger.data.config = {
		...trigger.data.config,
		triggerType: "schedule",
		scheduleCron: input.cron,
		scheduleTimezone: input.timezone,
	};
	const published = workflow.publishedAt
		? await db.workflowVersion.findFirst({
				where: {
					workflowId: workflow.id,
					version: workflow.publishedVersion ?? workflow.version,
					isPublished: true,
					userId: actor.userId,
					organizationId: actor.organizationId,
				},
				select: { nodes: true },
			})
		: null;
	const publishRequired =
		JSON.stringify(describeWorkflowSchedule(nodes)) !==
		JSON.stringify(
			published ? describeWorkflowSchedule(published.nodes) : null,
		);
	try {
		await applyWorkflowUpdateWithSchedule(
			actor,
			workflow,
			{
				id: workflow.id,
				nodes: nodes as unknown as Prisma.InputJsonValue,
			},
			{ expectedUpdatedAt: workflow.updatedAt },
		);
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "P2025"
		)
			throw new WorkflowCommandError(
				"CONFLICT",
				"The workflow changed. Refresh its schedule and review your edits before saving again.",
			);
		throw error;
	}

	auditLifecycle(actor, workflow.id, "schedule-configured");
	return {
		workflowId: workflow.id,
		saved: true,
		publishRequired,
		message: publishRequired
			? "Schedule saved to the draft. Publish to activate it."
			: "Schedule saved. This cadence is already published.",
	};
}
function auditLifecycle(actor: WorkflowActor, id: string, operation: string) {
	recordAudit({
		action: "activity.workflows.lifecycle",
		actor: { type: "user", userId: actor.userId },
		organizationId: actor.organizationId,
		resource: { type: "workflow", id },
		metadata: { operation },
	});
}
export async function changeWorkflowLifecycleCommand(
	actor: WorkflowActor,
	operation: "publish" | "unpublish" | "pause" | "resume" | "rollback",
	raw: unknown,
) {
	const identity = workflowIdentitySchema.parse({
		workflowId: (raw as Record<string, unknown>)?.workflowId,
	});
	let result: unknown;
	if (operation === "publish") {
		result = await publishWorkflowCommand(
			actor,
			workflowPublishSchema.parse(raw),
		);
	} else if (operation === "rollback") {
		result = await rollbackWorkflowCommand(
			actor,
			workflowRollbackSchema.parse(raw),
		);
	} else {
		const { workflowId } = workflowIdentitySchema.parse(raw);
		if (operation === "unpublish") {
			result = await unpublishWorkflowCommand(actor, workflowId);
		} else {
			const workflow = await (operation === "pause"
				? pauseWorkflowCommand
				: resumeWorkflowCommand)(actor, workflowId);
			result = { workflowId: workflow.id, status: workflow.status };
		}
	}
	if (
		operation !== "publish" &&
		operation !== "rollback" &&
		!(
			result &&
			typeof result === "object" &&
			"success" in result &&
			result.success === false
		)
	) {
		auditLifecycle(actor, identity.workflowId, operation);
	}
	return {
		workflowId: identity.workflowId,
		...(result as Record<string, unknown>),
	};
}
