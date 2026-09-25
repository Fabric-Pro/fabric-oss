/**
 * Selection resolution shared by the agentic-run `dispatch` and `quote`
 * procedures.
 *
 * Extracted so the two paths cannot drift apart: the pre-dispatch quote shown
 * beside the Start button has to resolve cases and estimate cost EXACTLY the
 * way dispatch itself does, or the figure a person confirms would not be the
 * figure dispatch actually enforces. Both procedures call the same two
 * functions below rather than each keeping its own copy of this logic.
 */

import { ORPCError } from "@orpc/client";
import {
	listCasesForAgenticRun,
	listTestCaseIdsForSelection,
} from "@repo/database";
import { hasPermission, Permissions } from "@repo/permissions";
import type { z } from "zod";
import { resolveEffectiveProjectPermissions } from "../../../lib/effective-project-permissions";
import {
	estimateRunCost,
	MAX_CASES_PER_RUN,
	type RunCostEstimate,
} from "./agentic-run-cost";
import type { testCaseSelectionSchema } from "./test-case-selection";

export type TestCaseSelection = z.infer<typeof testCaseSelectionSchema>;

export type AgenticRunMode = "MODE_A" | "MODE_B";

/**
 * Resolve a selection to the test case ids it matches, refusing an empty
 * match and a request too large to hold open as one run's worth of browser
 * sessions. The cap applies to the RESOLVED set, not the request, because a
 * filter is allowed to name thousands of cases even though a single run may
 * not cover that many.
 */
export async function resolveSelectedTestCaseIds(input: {
	projectId: string;
	selection: TestCaseSelection;
}): Promise<string[]> {
	const testCaseIds = await listTestCaseIdsForSelection(input);
	if (testCaseIds.length === 0) {
		throw new ORPCError("BAD_REQUEST", {
			message:
				input.selection.mode === "filter"
					? "No cases match the current filters, so there is nothing to run."
					: "Select at least one case to run.",
		});
	}
	if (testCaseIds.length > MAX_CASES_PER_RUN) {
		throw new ORPCError("BAD_REQUEST", {
			message: `That selection matches ${testCaseIds.length} cases; a single run can cover at most ${MAX_CASES_PER_RUN}. Narrow the filters and try again.`,
		});
	}
	return testCaseIds;
}

export interface AgenticRunModeResolution {
	cases: Awaited<ReturnType<typeof listCasesForAgenticRun>>;
	/**
	 * The REAL authored step count across the resolved cases, for both modes.
	 * This is what the dispatch success audit records — it always did, for
	 * MODE_B too, because "how many steps did this run cover" does not stop
	 * being a real fact about a scripted run just because Fabric doesn't bill
	 * for it. Only {@link estimate} zeroes the step count for MODE_B (a
	 * scripted run makes no model calls, so there is nothing to estimate).
	 */
	stepCount: number;
	estimate: RunCostEstimate;
}

/**
 * Resolve the cases a given run mode would actually execute out of the
 * already-resolved id set, and what that would cost — the same computation
 * dispatch uses to decide whether to refuse.
 */
export async function resolveAgenticRunMode(input: {
	projectId: string;
	testCaseIds: string[];
	runMode: AgenticRunMode;
}): Promise<AgenticRunModeResolution> {
	const cases = await listCasesForAgenticRun({
		projectId: input.projectId,
		testCaseIds: input.testCaseIds,
		runMode: input.runMode,
	});
	const stepCount = cases.reduce((n, c) => n + c.steps.length, 0);
	// The ESTIMATE is 0 steps for MODE_B — a scripted run bills nothing — but
	// `stepCount` itself above stays the real count for both modes.
	const estimate = estimateRunCost({
		caseCount: cases.length,
		stepCount: input.runMode === "MODE_B" ? 0 : stepCount,
	});
	return { cases, stepCount, estimate };
}

/**
 * May this user dispatch a MODE_B (scripted) run for this project?
 *
 * Scripted runs use a stored credential the same way Agentic ones do, but
 * `dispatch` has gated them one rung higher than the procedure's own
 * `TEST_CASE_UPDATE` floor since the feature shipped: only the project's
 * owner or someone with `PROJECT_SETTINGS_EDIT` may run one. Extracted here
 * so `quote` can report the same answer `dispatch` will enforce — the dialog
 * needs it to avoid defaulting, restoring, or offering a runner an ordinary
 * EDITOR cannot actually start.
 */
export async function isScriptedRunPermitted(input: {
	projectId: string;
	userId: string;
}): Promise<boolean> {
	const access = await resolveEffectiveProjectPermissions(
		input.projectId,
		input.userId,
	);
	return (
		access?.source === "owner" ||
		(access != null &&
			hasPermission(
				access.permissions,
				Permissions.PROJECT_SETTINGS_EDIT,
			))
	);
}
