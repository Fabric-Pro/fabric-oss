/**
 * Client-side backlog (PM) validation for the unified project wizard
 * (unified-project-setup spec §4.3, §11). Mirrors `ExistingProjectFlow` step 2:
 *
 * - Skipping the backlog card entirely is always allowed (AC#3) — no PM tool
 *   connected ⇒ no error.
 * - A connected PM tool requires a board/container before submit.
 * - Azure DevOps additionally requires a board/team (its data model is
 *   project → team → area path); the cascade writes `additionalContext.team`
 *   once a team is picked.
 *
 * Extracted as a pure function so the rule is unit-testable without rendering
 * the wizard, and so the submit handler and any future call site share one
 * source of truth. Returns a specific, user-facing error message, or `null`
 * when the backlog selection is valid (or absent).
 */

export interface BacklogValidationInput {
	/** True when a PM tool was actually picked (not the `__none__` sentinel). */
	hasBacklogConnected: boolean;
	/** The selected board/container id, or null when none chosen. */
	containerId: string | null;
	/** PM type detected from the MCP server's tool schema (e.g. `azure-devops`). */
	detectedType: string | null;
	/** PM additional context; for ADO this carries the selected `team`. */
	additionalContext: Record<string, unknown> | null;
}

export function getBacklogValidationError(
	input: BacklogValidationInput,
): string | null {
	if (!input.hasBacklogConnected) {
		return null;
	}

	const isAdo = input.detectedType === "azure-devops";

	if (!input.containerId) {
		return isAdo
			? "Please select a project"
			: "Please select a board to sync stories";
	}

	if (isAdo) {
		const team = input.additionalContext?.team;
		if (typeof team !== "string" || team.length === 0) {
			return "Please select a board/team for the Azure DevOps project";
		}
	}

	return null;
}
