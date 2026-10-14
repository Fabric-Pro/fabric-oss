/**
 * "Run now on API billing" for a bulk run paused for a ChatGPT plan reset
 * (Fizzy #2770): the scan, its review and grouping, and batch document
 * generation share it.
 *
 * The run's own override, never a policy change: the paused run's row moves
 * to PENDING with who approved it, its scheduled resume is stopped, and a
 * resume starts at once with `allowApiFallback: true` — a header every
 * activity of that run, and the agent token it mints, honours. Audited as a
 * warning, like the policy that does this for every run.
 *
 * It overrides the admins' "Wait for reset" policy and spends the
 * organization's money, so only an organization admin or owner may approve
 * it, never while acting as someone else.
 */

import { ORPCError } from "@orpc/server";
import {
	approveBulkRunApiOverride,
	type BulkRunKind,
	moveQueuedDocumentsToRun,
	organizationHasLlmApiProvider,
	revertBulkRunApiOverride,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	type AuditRequestContext,
	recordAuditFromRequest,
} from "../../../lib/audit";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import { requireOrgMembership } from "../../organizations/lib/membership";

const OVERRIDE_ROLES = ["admin", "owner"];

/**
 * Whether the organization has an LLM provider of its own to bill — not the
 * viewer's personal key, which the run (resolving as its owner) would not
 * use, and never the platform's gateway key.
 */
async function organizationCanBillApi(
	organizationId: string | null,
): Promise<boolean> {
	if (!organizationId) {
		return false;
	}
	try {
		return await organizationHasLlmApiProvider(organizationId);
	} catch {
		return false;
	}
}

async function isOverrideApprover(
	userId: string,
	organizationId: string,
): Promise<boolean> {
	return Boolean(
		await requireOrgMembership(userId, organizationId, OVERRIDE_ROLES),
	);
}

export interface PausedRunApiAccess {
	/** The viewer may approve "Run now on API billing". */
	canRunOnApi: boolean;
	/** The organization could bill it, but only an admin or owner may approve. */
	askAdminToRunOnApi: boolean;
}

export async function getPausedRunApiAccess(args: {
	organizationId: string | null;
	userId: string;
}): Promise<PausedRunApiAccess> {
	const { organizationId } = args;
	if (!organizationId || !(await organizationCanBillApi(organizationId))) {
		return { canRunOnApi: false, askAdminToRunOnApi: false };
	}
	const approver = await isOverrideApprover(args.userId, organizationId);
	return { canRunOnApi: approver, askAdminToRunOnApi: !approver };
}

const RESOURCE_TYPE: Record<BulkRunKind, string> = {
	PROJECT_SCAN: "project_scan",
	SCAN_REVIEW: "scan_finding_review",
	SCAN_GROUPING: "scan_finding_grouping",
	DOCUMENT_BATCH: "agent_task",
	ATLAS_ANALYSIS: "atlas_analysis_run",
	PROJECT_SETUP: "agent_task",
};

/** Kinds whose paused run holds documents queued for its resume. */
const QUEUES_DOCUMENTS: ReadonlySet<BulkRunKind> = new Set([
	"DOCUMENT_BATCH",
	"PROJECT_SETUP",
]);

export async function runPausedBulkRunOnApi(args: {
	context: AuditRequestContext;
	kind: BulkRunKind;
	runId: string;
	projectId: string;
	userId: string;
	organizationId: string | null;
	impersonatedBy?: string | null;
}): Promise<{ workflowId: string }> {
	if (args.impersonatedBy) {
		throw new ORPCError("FORBIDDEN", {
			message:
				"This run cannot be approved while acting as another user.",
		});
	}
	if (
		args.organizationId &&
		!(await isOverrideApprover(args.userId, args.organizationId))
	) {
		throw new ORPCError("FORBIDDEN", {
			message:
				"Only an organization admin or owner can run this now on API billing.",
		});
	}
	if (!(await organizationCanBillApi(args.organizationId))) {
		throw new ORPCError("PRECONDITION_FAILED", {
			message:
				"Your organization has no AI provider of its own to bill. Add one in Settings → AI Providers, or wait for the ChatGPT plan reset.",
		});
	}
	const approved = await approveBulkRunApiOverride({
		kind: args.kind,
		runId: args.runId,
		userId: args.userId,
	});
	if (!approved) {
		throw new ORPCError("CONFLICT", {
			message: "This run is no longer waiting for a ChatGPT plan reset.",
		});
	}
	const { resumeState, pauseCount, workflowId, scheduledWorkflowId } =
		approved;

	const { getTemporalClient } = await import("@repo/temporal");
	const client = await getTemporalClient();
	try {
		await client.workflow.start(
			resumeState.workflowType,
			withCorrelationMemo({
				taskQueue: resumeState.taskQueue,
				workflowId,
				args: [
					{
						...resumeState.input,
						resumeOf: {
							runId: args.runId,
							pauseCount,
							workflowIdBase: resumeState.workflowIdBase,
						},
						allowApiFallback: true,
					},
				],
				...(resumeState.executionTimeoutMs !== undefined && {
					workflowExecutionTimeout: resumeState.executionTimeoutMs,
				}),
			}),
		);
	} catch (error) {
		// Nothing would ever claim a PENDING row: put the run back to wait
		// for its scheduled resume, which still starts on time.
		await revertBulkRunApiOverride({
			kind: args.kind,
			runId: args.runId,
			pauseCount,
			resumesAt: approved.resumesAt,
			scheduledWorkflowId,
		});
		throw error;
	}

	if (QUEUES_DOCUMENTS.has(args.kind)) {
		await moveQueuedDocumentsToRun({
			fromWorkflowId: scheduledWorkflowId,
			toWorkflowId: workflowId,
		});
	}
	// The scheduled resume would find the row already taken and end on its
	// own; stopping it keeps it out of the run history.
	try {
		await client.workflow
			.getHandle(scheduledWorkflowId)
			.terminate("Run now on API billing");
	} catch {
		// Already gone, or never started — nothing to stop.
	}

	recordAuditFromRequest(args.context, {
		action: "org.chatgpt_plan.api_override_approved",
		category: "org",
		outcome: "success",
		severity: "warning",
		organizationId: args.organizationId,
		resource: {
			type: RESOURCE_TYPE[args.kind],
			id: args.runId,
			name: null,
		},
		metadata: { kind: args.kind, projectId: args.projectId, pauseCount },
	});
	logger.info("[BulkRunPause] Run now on API billing", {
		kind: args.kind,
		runId: args.runId,
		workflowId,
	});
	return { workflowId };
}
