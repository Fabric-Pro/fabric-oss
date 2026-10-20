/**
 * What every workflow command shares: who is acting, how a command refuses,
 * and the access questions each of them asks first.
 *
 * The workflow commands in `workflow-commands.ts` and
 * `workflow-execution-commands.ts` are the one implementation of each
 * operation. The oRPC procedures call them with the session's user and
 * organization, and the MCP gateway tools call them with the credential's, so
 * the two surfaces cannot drift on who may do what. A command takes its actor
 * explicitly: nothing here reads a request, a cookie or a header.
 */

import { ORPCError } from "@orpc/client";
import {
	canReadOrganizationWorkflows,
	canUpdateOrganizationWorkflows,
	getWorkflowById,
	projectPlacementRefusal,
} from "@repo/database";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

/** The organization member a command acts for. Organization is mandatory (ADR-018). */
export interface WorkflowActor {
	userId: string;
	organizationId: string;
	/** Optional caller restriction; it grants no project permission. */
	projectRestrictionId?: string;
}

export type WorkflowCommandErrorCode =
	| "NOT_FOUND"
	| "FORBIDDEN"
	| "BAD_REQUEST"
	| "CONFLICT"
	| "TOO_MANY_REQUESTS"
	| "INTERNAL_SERVER_ERROR";

/**
 * A refusal with a message written for a person. The oRPC procedures translate
 * it with {@link toOrpcError} (the `workflowCommandErrors` middleware does so
 * for them); the MCP tools put `message` in an error result.
 */
export class WorkflowCommandError extends Error {
	constructor(
		readonly code: WorkflowCommandErrorCode,
		message: string,
	) {
		super(message);
		this.name = "WorkflowCommandError";
	}
}

/**
 * The error a procedure should throw for `error`: the matching `ORPCError` for
 * a {@link WorkflowCommandError}, and anything else unchanged.
 */
export function toOrpcError(error: unknown): unknown {
	return error instanceof WorkflowCommandError
		? new ORPCError(error.code, { message: error.message })
		: error;
}

const WORKFLOW_NOT_FOUND = "Workflow not found";

function workflowNotFound(): WorkflowCommandError {
	return new WorkflowCommandError("NOT_FOUND", WORKFLOW_NOT_FOUND);
}

const NOT_A_MEMBER = "You are not a member of this organization";

/** The actor belongs to the organization they name, as of now. */
export async function requireWorkflowMembership(
	actor: WorkflowActor,
): Promise<void> {
	const membership = await verifyOrganizationMembership(
		actor.organizationId,
		actor.userId,
	);
	if (!membership) {
		throw new WorkflowCommandError("FORBIDDEN", NOT_A_MEMBER);
	}
}

/** Refuses with FORBIDDEN unless `permitted` says the actor holds the permission now. */
export async function requireWorkflowPermission(
	permitted: (userId: string, organizationId: string) => Promise<boolean>,
	actor: WorkflowActor,
	message: string,
): Promise<void> {
	if (!(await permitted(actor.userId, actor.organizationId))) {
		throw new WorkflowCommandError("FORBIDDEN", message);
	}
}

/**
 * The workflow a command would act on, once the actor is known to belong to the
 * organization and to hold `permitted` now.
 *
 * A workflow is user-owned even inside an organization, so ownership is part of
 * access. The row is read with the owner and organization in the filter: a
 * person who belongs to two organizations must not reach one organization's
 * workflow while acting in the other. Every refusal about the row is the same
 * NOT_FOUND, so the answer never says whether a workflow exists elsewhere.
 *
 * The membership, the permission and the row are three independent reads, so
 * they run together and are judged in order afterwards: a non-member is told
 * so, then a member without the permission (`refusal` is the message), and only
 * then is a missing row reported.
 */
export async function loadPermittedWorkflow(
	actor: WorkflowActor,
	workflowId: string,
	permission: {
		permitted: (userId: string, organizationId: string) => Promise<boolean>;
		refusal: string;
	},
) {
	const [membership, permitted, workflow] = await Promise.all([
		verifyOrganizationMembership(actor.organizationId, actor.userId),
		permission.permitted(actor.userId, actor.organizationId),
		getWorkflowById(workflowId, actor.userId, actor.organizationId),
	]);
	if (!membership) {
		throw new WorkflowCommandError("FORBIDDEN", NOT_A_MEMBER);
	}
	if (!permitted) {
		throw new WorkflowCommandError("FORBIDDEN", permission.refusal);
	}
	if (
		!workflow ||
		(actor.projectRestrictionId !== undefined &&
			workflow.projectId !== actor.projectRestrictionId)
	) {
		throw workflowNotFound();
	}
	return workflow;
}

/**
 * The workflow an edit-class command (edit, publish, unpublish, pause, resume)
 * would change, once the actor is known to be allowed to change it. `verb`
 * names the operation in the permission refusal.
 */
export function loadEditableWorkflow(
	actor: WorkflowActor,
	workflowId: string,
	verb: "edit" | "publish" | "unpublish" | "pause" | "resume",
) {
	return loadPermittedWorkflow(actor, workflowId, {
		permitted: canUpdateOrganizationWorkflows,
		refusal: `You do not have permission to ${verb} workflows in this organization`,
	});
}

const READ_REFUSAL =
	"You do not have permission to read workflows in this organization";

/** The workflow a read-class command (run history, a single workflow) would show. */
export function loadReadableWorkflow(actor: WorkflowActor, workflowId: string) {
	return loadPermittedWorkflow(actor, workflowId, {
		permitted: canReadOrganizationWorkflows,
		refusal: READ_REFUSAL,
	});
}

/**
 * The actor belongs to the organization and may read its workflows, as of now,
 * for a read that names no single workflow (a listing, an execution by id). The
 * two reads run together and are judged in that order.
 */
export async function requireReadAccess(actor: WorkflowActor): Promise<void> {
	const [membership, permitted] = await Promise.all([
		verifyOrganizationMembership(actor.organizationId, actor.userId),
		canReadOrganizationWorkflows(actor.userId, actor.organizationId),
	]);
	if (!membership) {
		throw new WorkflowCommandError("FORBIDDEN", NOT_A_MEMBER);
	}
	if (!permitted) {
		throw new WorkflowCommandError("FORBIDDEN", READ_REFUSAL);
	}
}

/**
 * The project a workflow is attached to must be one the actor may change and
 * that is hosted by their organization and not in the trash: a scheduled
 * workflow publishes its output into that project, so attaching one is a write
 * to it. A project the actor can open but not change is reported the same way
 * as a missing one, so attaching never confirms that it exists.
 */
export async function requireWritableProject(
	actor: WorkflowActor,
	projectId: string,
): Promise<void> {
	const refusal = await projectPlacementRefusal({
		userId: actor.userId,
		organizationId: actor.organizationId,
		projectId,
	});
	if (refusal) {
		throw new WorkflowCommandError("NOT_FOUND", "Project not found");
	}
}
