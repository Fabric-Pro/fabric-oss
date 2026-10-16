/**
 * The workflow commands — create, edit, publish, unpublish, pause, resume.
 *
 * One implementation of each operation, called by the oRPC procedures with the
 * session's user and organization and by the MCP gateway tools with the
 * credential's. Each command takes an explicit actor, asks the actor's current
 * organization permission itself (a stored API-key scope says what a key was
 * granted, not what its owner may do now) and refuses with a
 * `WorkflowCommandError`. Starting a run and reading run history are in
 * `workflow-execution-commands.ts`.
 */

import crypto from "node:crypto";
import {
	canCreateOrganizationWorkflows,
	createWorkflow,
	db,
	isWorkflowLive,
	type Prisma,
	updateWorkflow,
	type WorkflowBuilderStatus,
	type WorkflowTriggerType,
} from "@repo/database";
import { findScheduleCron } from "@repo/temporal";
import { decryptApiKeyMaybe, encryptApiKey } from "@repo/utils";
import { findAgenticPublishProblems } from "./agentic-publish-validation";
import { syncWorkflowSchedule } from "./sync-workflow-schedule";
import {
	loadEditableWorkflow,
	requireWorkflowMembership,
	requireWorkflowPermission,
	requireWritableProject,
	WorkflowCommandError,
	type WorkflowActor,
} from "./workflow-command-context";
import { validateWorkflowBeforeExecution } from "./workflow-validation";

export interface CreateWorkflowInput {
	name: string;
	description?: string;
	triggerType?: WorkflowTriggerType;
	triggerConfig?: Prisma.InputJsonValue;
	nodes?: Prisma.InputJsonValue;
	edges?: Prisma.InputJsonValue;
	variables?: Prisma.InputJsonValue;
	settings?: Prisma.InputJsonValue;
	isTemplate?: boolean;
	templateId?: string;
	projectId?: string;
}

/**
 * The questions creating a workflow asks before it writes: membership, the
 * live permission, and the project it is attached to. Exported so a dry run
 * refuses exactly where the real create would.
 */
export async function assertMayCreateWorkflow(
	actor: WorkflowActor,
	projectId?: string,
): Promise<void> {
	await requireWorkflowMembership(actor);
	await requireWorkflowPermission(
		canCreateOrganizationWorkflows,
		actor,
		"You do not have permission to create workflows in this organization",
	);
	if (projectId) {
		await requireWritableProject(actor, projectId);
	}
}

export async function createWorkflowCommand(
	actor: WorkflowActor,
	input: CreateWorkflowInput,
) {
	await assertMayCreateWorkflow(actor, input.projectId);
	return insertWorkflow(actor, input);
}

/**
 * The write half of {@link createWorkflowCommand}, for a caller that has
 * already asked {@link assertMayCreateWorkflow} (a draft is built between the
 * two, and only for an actor who may create).
 */
export async function insertWorkflow(
	actor: WorkflowActor,
	input: CreateWorkflowInput,
) {
	const workflow = await createWorkflow({
		...input,
		userId: actor.userId,
		organizationId: actor.organizationId,
	});
	if (!workflow) {
		throw new WorkflowCommandError(
			"INTERNAL_SERVER_ERROR",
			"Failed to create workflow",
		);
	}
	return workflow;
}

export interface UpdateWorkflowInput {
	id: string;
	name?: string;
	description?: string;
	status?: WorkflowBuilderStatus;
	triggerType?: WorkflowTriggerType;
	triggerConfig?: Prisma.InputJsonValue;
	nodes?: Prisma.InputJsonValue;
	edges?: Prisma.InputJsonValue;
	variables?: Prisma.InputJsonValue;
	settings?: Prisma.InputJsonValue;
}

/** A workflow row as a command loads it for editing. */
export type EditableWorkflow = Awaited<ReturnType<typeof loadEditableWorkflow>>;

export async function updateWorkflowCommand(
	actor: WorkflowActor,
	input: UpdateWorkflowInput,
) {
	const current = await loadEditableWorkflow(actor, input.id, "edit");
	return applyWorkflowUpdate(actor, current, input);
}

/**
 * Applies an edit to a workflow the caller has already loaded with
 * {@link loadEditableWorkflow}, so the commands that load once for a reason of
 * their own (pause, resume, an edit that first builds a draft) do not read it
 * again.
 */
export async function applyWorkflowUpdate(
	actor: WorkflowActor,
	current: EditableWorkflow,
	input: UpdateWorkflowInput,
) {
	// A live workflow's graph is held to the same agentic checks as publish:
	// editing nodes in place, or reviving a paused workflow, must not let an
	// unvalidated agent onto its schedule.
	if (
		(input.nodes !== undefined || input.status !== undefined) &&
		isWorkflowLive(input.status ?? current.status)
	) {
		const { problems } = await findAgenticPublishProblems({
			nodes: input.nodes ?? current.nodes,
			userId: current.userId,
			organizationId: actor.organizationId,
			projectId: current.projectId ?? null,
		});
		if (problems.length > 0) {
			throw new WorkflowCommandError("BAD_REQUEST", problems.join("\n"));
		}
	}

	const { id, ...patch } = input;
	const workflow = await updateWorkflow(
		id,
		actor.userId,
		patch,
		actor.organizationId,
	);

	// Editing a PUBLISHED workflow's trigger must take effect immediately:
	// changing the cron, or switching the trigger away from Schedule,
	// should not require an unpublish/republish cycle.
	//
	// A status change has to sync too, and in both directions. Pausing a
	// workflow used to leave its schedule running — this branch only fired
	// for PUBLISHED/ACTIVE, so moving to PAUSED simply skipped it and the
	// cron kept firing against a workflow the author believed was stopped.
	// Autosave is the reason this is not unconditional: a draft save posts
	// no status, and reaching for Temporal on every keystroke would be a
	// round trip for nothing.
	const scheduleShouldBeLive = isWorkflowLive(workflow.status);
	if (scheduleShouldBeLive || input.status !== undefined) {
		await syncWorkflowSchedule({
			workflowId: id,
			nodes: workflow.nodes,
			userId: workflow.userId,
			organizationId: workflow.organizationId,
			projectId: workflow.projectId,
			workflowName: workflow.name,
			active: scheduleShouldBeLive,
		});
	}

	return workflow;
}

interface PublishWorkflowInput {
	workflowId: string;
	changelog?: string;
	enableWebhook?: boolean;
	/** Skips the graph checks only. The agentic checks are never skippable. */
	skipValidation?: boolean;
}

interface PublishValidation {
	valid: boolean;
	errors: string[];
	warnings: string[];
	issues?: Array<{
		field: string;
		message: string;
		severity: "error" | "warning";
	}>;
}

type PublishWorkflowOutcome =
	| {
			success: true;
			version: number;
			publishedAt: Date;
			webhookUrl?: string;
			webhookSecret?: string;
			schedule: Awaited<ReturnType<typeof syncWorkflowSchedule>>;
			validation: PublishValidation;
	  }
	| { success: false; validation: PublishValidation };

/**
 * Publishes a workflow as a new version and makes it live, syncing its
 * schedule. A refused publish resolves with the problems rather than throwing:
 * validation errors are an answer, not an exception.
 */
export async function publishWorkflowCommand(
	actor: WorkflowActor,
	input: PublishWorkflowInput,
): Promise<PublishWorkflowOutcome> {
	const { workflowId, changelog, enableWebhook, skipValidation } = input;
	const workflow = await loadEditableWorkflow(actor, workflowId, "publish");

	const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
	const edges = Array.isArray(workflow.edges) ? workflow.edges : [];
	const validation = validateWorkflowBeforeExecution(nodes, edges);

	// An agent that runs unattended is settled before it can go live, so
	// `skipValidation` does not reach these.
	const { problems: agenticProblems } = await findAgenticPublishProblems({
		nodes,
		userId: workflow.userId,
		organizationId: workflow.organizationId,
		projectId: workflow.projectId ?? null,
	});
	if (agenticProblems.length > 0) {
		return {
			success: false,
			validation: {
				valid: false,
				errors: agenticProblems,
				warnings: validation.warnings,
				issues: agenticProblems.map((message) => ({
					field: "graph",
					message,
					severity: "error" as const,
				})),
			},
		};
	}

	if (!validation.valid && !skipValidation) {
		console.log(
			`[Publish] Pre-flight validation failed for workflow ${workflowId}:`,
			validation.errors,
		);
		return {
			success: false,
			validation: {
				valid: false,
				errors: validation.errors,
				warnings: validation.warnings,
				issues: validation.errors.map((message) => ({
					field: "graph",
					message,
					severity: "error" as const,
				})),
			},
		};
	}

	if (validation.warnings.length > 0) {
		console.log(
			`[Publish] Pre-flight validation warnings for workflow ${workflowId}:`,
			validation.warnings,
		);
	}

	const latestVersion = await db.workflowVersion.findFirst({
		where: { workflowId },
		orderBy: { version: "desc" },
		select: { version: true },
	});
	const newVersion = (latestVersion?.version ?? 0) + 1;

	// Generate a webhook secret only when enabling webhooks for the first
	// time. `existingSecret` may already be encrypted at rest; only a freshly
	// generated secret is plaintext and must be encrypted on write (SOC 2
	// CC6.1) — re-encrypting an existing value would double-encrypt it.
	const existingSecret = workflow.webhookSecret;
	const newPlaintextSecret =
		enableWebhook && !existingSecret
			? `whsec_${crypto.randomBytes(32).toString("hex")}`
			: null;

	// TENANT ISOLATION: the version row carries the workflow's own userId and
	// organizationId for tenant filtering on child tables.
	const publishedAt = new Date();
	await db.workflowVersion.create({
		data: {
			workflowId,
			version: newVersion,
			nodes: workflow.nodes ?? {},
			edges: workflow.edges ?? {},
			variables: workflow.variables ?? undefined,
			settings: workflow.settings ?? undefined,
			triggerConfig: workflow.triggerConfig ?? undefined,
			changelog,
			isPublished: true,
			publishedAt,
			createdBy: actor.userId,
			userId: workflow.userId,
			organizationId: workflow.organizationId,
		},
	});

	// A workflow whose trigger node carries a cron becomes SCHEDULE-triggered
	// on publish. `enableWebhook` still wins when both are set: an explicit
	// webhook request is a deliberate act, a leftover cron on the trigger node
	// is not.
	const scheduleCron = findScheduleCron(workflow.nodes);

	await db.workflow.update({
		where: { id: workflowId },
		data: {
			status: "PUBLISHED",
			version: newVersion,
			publishedAt,
			publishedBy: actor.userId,
			publishedVersion: newVersion,
			webhookSecret: enableWebhook
				? newPlaintextSecret
					? encryptApiKey(newPlaintextSecret)
					: existingSecret
				: workflow.webhookSecret,
			triggerType: enableWebhook
				? "WEBHOOK"
				: scheduleCron
					? "SCHEDULE"
					: workflow.triggerType,
		},
	});

	// A Schedule trigger only becomes live on publish.
	const schedule = await syncWorkflowSchedule({
		workflowId,
		nodes: workflow.nodes,
		userId: workflow.userId,
		organizationId: workflow.organizationId,
		projectId: workflow.projectId,
		workflowName: workflow.name,
		active: true,
	});

	const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
	return {
		success: true,
		version: newVersion,
		publishedAt,
		webhookUrl: enableWebhook
			? `${baseUrl}/api/workflows/trigger/${workflowId}`
			: undefined,
		webhookSecret: enableWebhook
			? (newPlaintextSecret ??
				decryptApiKeyMaybe(existingSecret) ??
				undefined)
			: undefined,
		schedule,
		validation: {
			valid: true,
			errors: [],
			warnings: validation.warnings,
		},
	};
}

/** Reverts a workflow to draft and removes its schedule. */
export async function unpublishWorkflowCommand(
	actor: WorkflowActor,
	workflowId: string,
): Promise<{ success: true; message: string }> {
	const workflow = await loadEditableWorkflow(actor, workflowId, "unpublish");

	await db.workflow.update({
		where: { id: workflowId },
		data: {
			status: "DRAFT",
			// Keep the published version info for reference
		},
	});

	// A draft must not keep firing. Removing the schedule here is what makes
	// "unpublish" mean "stop", rather than leaving a cron running against a
	// workflow the user believes is inactive.
	await syncWorkflowSchedule({
		workflowId,
		nodes: workflow.nodes,
		userId: workflow.userId,
		organizationId: workflow.organizationId,
		projectId: workflow.projectId,
		workflowName: workflow.name,
		active: false,
	});

	return {
		success: true,
		message: "Workflow unpublished and reverted to draft status",
	};
}

/**
 * Stops a live workflow without unpublishing it: status PAUSED and its
 * schedule removed. Its published version is kept, so resuming it needs no
 * republish.
 */
export async function pauseWorkflowCommand(
	actor: WorkflowActor,
	workflowId: string,
) {
	const workflow = await loadEditableWorkflow(actor, workflowId, "pause");
	if (workflow.status === "PAUSED") {
		return workflow;
	}
	if (!isWorkflowLive(workflow.status)) {
		throw new WorkflowCommandError(
			"BAD_REQUEST",
			`Workflow is ${workflow.status}; only a published workflow can be paused`,
		);
	}
	return applyWorkflowUpdate(actor, workflow, {
		id: workflowId,
		status: "PAUSED",
	});
}

/** Puts a paused workflow back on its schedule: status PUBLISHED, schedule recreated. */
export async function resumeWorkflowCommand(
	actor: WorkflowActor,
	workflowId: string,
) {
	const workflow = await loadEditableWorkflow(actor, workflowId, "resume");
	if (isWorkflowLive(workflow.status)) {
		return workflow;
	}
	if (workflow.status !== "PAUSED") {
		throw new WorkflowCommandError(
			"BAD_REQUEST",
			`Workflow is ${workflow.status}; only a paused workflow can be resumed`,
		);
	}
	if (!workflow.publishedAt) {
		throw new WorkflowCommandError(
			"BAD_REQUEST",
			"Workflow has never been published; publish it instead of resuming it",
		);
	}
	return applyWorkflowUpdate(actor, workflow, {
		id: workflowId,
		status: "PUBLISHED",
	});
}
