/**
 * Unit tests for the unified wizard's backlog (PM) validation rule
 * (unified-project-setup spec §4.3, §11; tasks TG1 §1.1, §1.3).
 *
 * Behavior under test (mirrors `ExistingProjectFlow` step 2):
 *   - Skipping the backlog card is always allowed (AC#3) → no error.
 *   - A connected PM tool with no container blocks submit with specific copy.
 *   - Azure DevOps additionally requires a board/team.
 */

import { describe, expect, it } from "vitest";
import { getBacklogValidationError } from "../backlog-validation";

describe("getBacklogValidationError", () => {
	it("returns null when no backlog is connected (skipping is allowed — AC#3)", () => {
		expect(
			getBacklogValidationError({
				hasBacklogConnected: false,
				containerId: null,
				detectedType: null,
				additionalContext: null,
			}),
		).toBeNull();
	});

	it("blocks submit with specific copy when a PM tool is selected but no board/container is chosen", () => {
		expect(
			getBacklogValidationError({
				hasBacklogConnected: true,
				containerId: null,
				detectedType: "jira",
				additionalContext: null,
			}),
		).toBe("Please select a board to sync stories");
	});

	it("asks to pick a project (ADO wording) when ADO is selected with no container", () => {
		expect(
			getBacklogValidationError({
				hasBacklogConnected: true,
				containerId: null,
				detectedType: "azure-devops",
				additionalContext: null,
			}),
		).toBe("Please select a project");
	});

	it("requires a board/team for Azure DevOps even when a project (container) is chosen", () => {
		expect(
			getBacklogValidationError({
				hasBacklogConnected: true,
				containerId: "proj-123",
				detectedType: "azure-devops",
				additionalContext: { adoProjectId: "proj-123" },
			}),
		).toBe("Please select a board/team for the Azure DevOps project");
	});

	it("passes for Azure DevOps once both the project and a team are selected", () => {
		expect(
			getBacklogValidationError({
				hasBacklogConnected: true,
				containerId: "proj-123",
				detectedType: "azure-devops",
				additionalContext: { team: "Platform Team" },
			}),
		).toBeNull();
	});

	it("passes for a non-ADO PM tool once a board/container is selected (no team required)", () => {
		expect(
			getBacklogValidationError({
				hasBacklogConnected: true,
				containerId: "board-9",
				detectedType: "linear",
				additionalContext: null,
			}),
		).toBeNull();
	});
});
