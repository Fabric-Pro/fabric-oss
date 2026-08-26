/**
 * BacklogChangeProposal — inline decision-contradiction note.
 *
 * The async decision pre-check flags a change as contradicting a logged
 * architecture decision. Findings reach the change card via the proposal-level
 * `decisionConflicts` prop, matched to each change by `changeRef.index`. The
 * note is advisory only — "Apply Selected" is never disabled by a warning.
 */

import type {
	DecisionConflictFinding,
	DecisionPrecheckResult,
} from "@repo/agent-types";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import * as axeMatchers from "vitest-axe/matchers";

expect.extend(axeMatchers);

vi.mock("../../../../../shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			stories: {
				checkPmSyncConflicts: vi
					.fn()
					.mockResolvedValue({ results: [] }),
				retryPmSyncBatch: vi.fn(),
			},
		},
	},
}));

vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent: vi.fn() }),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	useBasePath: () => "/app/acme",
}));

import {
	BacklogChangeProposal,
	type ChangeItem,
} from "../BacklogChangeProposal";

function buildFinding(
	overrides: Partial<DecisionConflictFinding> = {},
): DecisionConflictFinding {
	return {
		decisionId: "dec-1",
		decisionIdentifier: "ADR-012",
		decisionTitle: "Use Postgres for all persistence",
		natureOfConflict: "Introduces a MongoDB store for events.",
		conflictType: "violates_accepted",
		confidence: 0.9,
		...overrides,
	};
}

function buildChange(overrides: Partial<ChangeItem> = {}): ChangeItem {
	return {
		type: "feature",
		action: "create",
		title: { to: "Event store" },
		reasoning: "Captured from the planning thread.",
		sourceContext: "teams_messages",
		...overrides,
	};
}

function renderProposal(
	props: Partial<React.ComponentProps<typeof BacklogChangeProposal>> = {},
) {
	return render(
		<BacklogChangeProposal
			summary="Test proposal"
			contextSummary="Captured from a Teams thread"
			changes={props.changes ?? [buildChange()]}
			projectId="proj_1"
			hasPMTool={false}
			onApprove={vi.fn()}
			onReject={vi.fn()}
			{...props}
		/>,
	);
}

const conflictsResult = (
	findings: DecisionConflictFinding[],
): DecisionPrecheckResult => ({
	checkedAt: "2026-07-10T00:00:00.000Z",
	status: "conflicts",
	findings,
});

describe("BacklogChangeProposal decision-conflict note", () => {
	it("renders the note when the proposal-level result targets the change", () => {
		renderProposal({
			changes: [buildChange()],
			decisionConflicts: conflictsResult([
				buildFinding({ changeRef: { index: 0 } }),
			]),
		});

		expect(screen.getByText(/ADR-012/)).toBeInTheDocument();
		expect(
			screen.getByText(/Use Postgres for all persistence/),
		).toBeInTheDocument();
		expect(
			screen.getByText("Introduces a MongoDB store for events."),
		).toBeInTheDocument();
	});

	it("matches proposal-level findings to a change by changeRef.index", () => {
		renderProposal({
			changes: [
				buildChange({ title: { to: "Untouched change" } }),
				buildChange({ title: { to: "Conflicting change" } }),
			],
			decisionConflicts: conflictsResult([
				buildFinding({ changeRef: { index: 1 } }),
			]),
		});

		// The finding targets index 1, so exactly one note renders.
		expect(screen.getByText(/ADR-012/)).toBeInTheDocument();
		expect(screen.getAllByText(/ADR-012/)).toHaveLength(1);
	});

	it("renders nothing when there are no findings", () => {
		renderProposal({ changes: [buildChange()] });

		expect(screen.queryByText("changeNoteLabel")).not.toBeInTheDocument();
		expect(screen.queryByText(/ADR-012/)).not.toBeInTheDocument();
	});

	it("ignores an ok result with no conflicts", () => {
		renderProposal({
			changes: [buildChange()],
			decisionConflicts: {
				checkedAt: "2026-07-10T00:00:00.000Z",
				status: "ok",
				findings: [],
			},
		});

		expect(screen.queryByText(/ADR-012/)).not.toBeInTheDocument();
	});

	it("keeps Apply Selected enabled while a warning is present", () => {
		renderProposal({
			changes: [buildChange()],
			decisionConflicts: conflictsResult([
				buildFinding({ changeRef: { index: 0 } }),
			]),
		});

		const applyButton = screen.getByRole("button", {
			name: /Apply Selected/,
		});
		expect(applyButton).toBeEnabled();
	});

	it("has no axe violations with a warning present", async () => {
		const { container } = renderProposal({
			changes: [buildChange()],
			decisionConflicts: conflictsResult([
				buildFinding({ changeRef: { index: 0 } }),
			]),
		});

		expect(await axe(container)).toHaveNoViolations();
	});
});
