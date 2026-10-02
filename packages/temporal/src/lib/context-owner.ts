/**
 * Who owns the context a file-processing, embedding or deletion run works on
 * (Fizzy #2719).
 *
 * The ingestion pipeline was written for `ProjectContext` rows. Company
 * context — the sources an organization maintains once about itself — goes
 * through the same workflows and activities, told apart by an optional
 * `owner` on their inputs:
 *
 * - `{ kind: "project", projectId }` — a project context, as always;
 * - `{ kind: "company", organizationId }` — a `CompanyContextSource`.
 *
 * A missing owner is the project owner. Every input recorded before company
 * context existed, and every schedule's arguments, carry none, so they keep
 * running exactly as they did.
 *
 * Workflow-safe: imported by workflow code, so nothing here does I/O, and the
 * only import is the dependency-free task queue module.
 */

import { ApplicationFailure } from "@temporalio/common";
import { COMPANY_CONTEXT_TASK_QUEUE } from "../task-queues";

export interface ProjectContextOwner {
	kind: "project";
	projectId: string;
}

export interface CompanyContextOwner {
	kind: "company";
	organizationId: string;
}

export type ContextOwner = ProjectContextOwner | CompanyContextOwner;

/** `ApplicationFailure.type` of an owner no run can act on. */
export const CONTEXT_OWNER_INVALID = "CONTEXT_OWNER_INVALID";

function invalidOwner(message: string): ApplicationFailure {
	return ApplicationFailure.nonRetryable(message, CONTEXT_OWNER_INVALID);
}

/**
 * The owner an input names, validated.
 *
 * A missing owner resolves to `{ kind: "project", projectId }` from the
 * input's own `projectId`, deliberately without checking it: that is the path
 * every existing input takes, and it behaves exactly as it did before owners
 * existed.
 *
 * A named owner must be whole, and must agree with the input's own
 * `projectId` or `organizationId` where the input carries one. Anything else
 * fails non-retryably: a retry cannot supply a missing tenant.
 */
export function resolveContextOwner(input: {
	projectId?: string | null;
	organizationId?: string | null;
	owner?: ContextOwner | null;
}): ContextOwner {
	const { owner } = input;
	if (owner === undefined || owner === null) {
		return { kind: "project", projectId: input.projectId as string };
	}

	if (owner.kind === "company") {
		if (typeof owner.organizationId !== "string" || !owner.organizationId) {
			throw invalidOwner(
				"A company context owner requires an organizationId",
			);
		}
		if (
			typeof input.organizationId === "string" &&
			input.organizationId !== "" &&
			input.organizationId !== owner.organizationId
		) {
			throw invalidOwner(
				"The company context owner's organization does not match the input's",
			);
		}
		return { kind: "company", organizationId: owner.organizationId };
	}

	if (owner.kind === "project") {
		const projectId = owner.projectId || input.projectId;
		if (typeof projectId !== "string" || !projectId) {
			throw invalidOwner("A project context owner requires a projectId");
		}
		if (input.projectId && input.projectId !== projectId) {
			throw invalidOwner(
				"The project context owner's project does not match the input's",
			);
		}
		return { kind: "project", projectId };
	}

	throw invalidOwner(
		`Unknown context owner kind: ${String((owner as { kind?: unknown }).kind)}`,
	);
}

/**
 * The company owner an input names, validated, or null for a project owner
 * (including a missing one). For activities whose arguments carry no project,
 * which only need to know whether the row is a company source.
 */
export function companyContextOwnerOf(
	owner: ContextOwner | null | undefined,
): CompanyContextOwner | null {
	if (owner === undefined || owner === null || owner.kind === "project") {
		return null;
	}
	const resolved = resolveContextOwner({ owner });
	return resolved.kind === "company" ? resolved : null;
}

/**
 * The queue a context workflow for this owner starts on. Every starter picks
 * its queue through this: a company owner always goes to
 * `COMPANY_CONTEXT_TASK_QUEUE`, whatever queue the project starts use, so a
 * worker without company support can never pick the job up and run it down
 * the project path.
 *
 * The starter is the only place this can be enforced. The workflows cannot
 * check their own queue: `workflowInfo().taskQueue` is the replaying worker's
 * queue, and a replay tool's is a placeholder, so such a check would fail
 * every company history under replay validation.
 */
export function contextOwnerTaskQueue(
	owner: ContextOwner | null | undefined,
	projectTaskQueue: string,
): string {
	return owner?.kind === "company"
		? COMPANY_CONTEXT_TASK_QUEUE
		: projectTaskQueue;
}
