/**
 * Starting a member's time-suggestion run: the one path every start takes,
 * whether the member pressed "Check my activity" or Fabric started it on its
 * own (see `./automatic-suggestions`).
 *
 * A run reads the member's activity on the projects it is given, so each
 * caller decides those first with {@link loggableSuggestionProjects}, and an
 * automatic start narrows them further with
 * {@link automaticSuggestionProjects}.
 */

import { ORPCError } from "@orpc/server";
import {
	failTimeSuggestionRun,
	listTimeAccessRows,
	startTimeSuggestionRun,
} from "@repo/database";
import { Permissions } from "@repo/permissions";
import { suggestsTimeAutomatically } from "@repo/utils/time-suggestions";
import type { ProjectBillingModel } from "@repo/utils/time-tracking";
import { projectsWithPermission } from "./project-access";

interface SuggestionProject {
	id: string;
	name: string;
	billingModel: ProjectBillingModel;
}

type StartTimeSuggestionsResult =
	| { status: "started"; runId: string }
	| { status: "in-progress" }
	| { status: "unavailable" };

/**
 * The organization's active projects the member can discover and log time on
 * now: the only ones a run may read their activity on.
 */
export async function loggableSuggestionProjects(params: {
	organizationId: string;
	userId: string;
}): Promise<SuggestionProject[]> {
	const rows = await listTimeAccessRows({
		organizationId: params.organizationId,
		userId: params.userId,
		projects: "loggable",
	});
	return projectsWithPermission(rows, Permissions.TIME_LOG, new Date()).map(
		(project) => ({
			id: project.id,
			name: project.name,
			billingModel: project.billingModel,
		}),
	);
}

/** The projects a run Fabric starts on its own may read. */
export function automaticSuggestionProjects(
	projects: readonly SuggestionProject[],
): SuggestionProject[] {
	return projects.filter((project) =>
		suggestsTimeAutomatically(project.billingModel),
	);
}

/**
 * Open a run for the member over `fromDate`..`toDate` and start the workflow
 * that fills it. One run at a time per member and organization: a second
 * start while one runs answers `in-progress`.
 *
 * `automatic` records who started the run: true when Fabric did on its own,
 * false when the member asked. The run's suggestions copy it, and the To
 * confirm list hides automatic ones while their project is fixed bid.
 *
 * Throws INTERNAL_SERVER_ERROR when the workflow cannot start, after
 * releasing the run.
 */
export async function startTimeSuggestions(params: {
	organizationId: string;
	userId: string;
	fromDate: string;
	toDate: string;
	timezone: string;
	projects: readonly SuggestionProject[];
	automatic: boolean;
}): Promise<StartTimeSuggestionsResult> {
	const { organizationId, userId, fromDate, toDate, timezone, automatic } =
		params;

	// Checked before the run row exists: a row created first would hold the
	// member's slot over an outage that may already be over.
	const { isTemporalAvailable } = await import("@repo/temporal");
	if (!(await isTemporalAvailable())) {
		return { status: "unavailable" };
	}

	const run = await startTimeSuggestionRun({
		organizationId,
		userId,
		fromDate,
		toDate,
		timezone,
		automatic,
	});
	if (run.status === "in_flight") {
		return { status: "in-progress" };
	}

	const { getTemporalClient } = await import("@repo/temporal");
	const client = await getTemporalClient();
	try {
		await client.workflow.start("generateTimeSuggestionsWorkflow", {
			taskQueue: "fabric-worker",
			// Keyed on the run: each run is its own row with its own terminal
			// state.
			workflowId: `time-suggestions:${run.runId}`,
			workflowIdReusePolicy: "ALLOW_DUPLICATE",
			workflowIdConflictPolicy: "FAIL",
			// Matches the run timeout after which a new start reclaims the
			// slot.
			workflowExecutionTimeout: "10m",
			args: [
				{
					runId: run.runId,
					organizationId,
					userId,
					fromDate,
					toDate,
					timezone,
					projects: params.projects.map((project) => ({
						id: project.id,
						name: project.name,
					})),
				},
			],
		});
	} catch (error) {
		if (
			error instanceof Error &&
			error.name === "WorkflowExecutionAlreadyStartedError"
		) {
			return { status: "in-progress" };
		}
		// Release the slot, or every retry is refused until the run times out.
		await failTimeSuggestionRun({
			runId: run.runId,
			organizationId,
			userId,
			error: "Could not start generation",
		});
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			message: "Could not start generating time suggestions",
		});
	}

	return { status: "started", runId: run.runId };
}
