/**
 * A Roadmap recommendation batch stays open after a partial accept
 * (Fizzy #2208, AC-15): what was already accepted is locked, it makes
 * Features only, and nothing is drafted while it is in review.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { orpcClient } from "../../../../../shared/lib/orpc-client";
import {
	BacklogChangeProposal,
	type ChangeItem,
} from "../BacklogChangeProposal";

vi.mock("../../../../../shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			stories: {
				checkPmSyncConflicts: vi.fn(async () => ({ results: [] })),
				retryPmSyncBatch: vi.fn(),
				reformatProposalBody: vi.fn(),
			},
		},
	},
}));

const reformatMock = orpcClient.projects.stories
	.reformatProposalBody as unknown as ReturnType<typeof vi.fn>;

function feature(title: string): ChangeItem {
	return {
		type: "feature",
		action: "create",
		title: { to: title },
		description: { to: `${title}, described.` },
		reasoning: "Test fixture",
		sourceContext: "multiple",
	};
}

const CHANGES = [feature("Alpha"), feature("Bravo"), feature("Charlie")];

function renderBatch(
	props: Partial<Parameters<typeof BacklogChangeProposal>[0]> = {},
) {
	const onApprove = vi.fn();
	render(
		<BacklogChangeProposal
			summary="Recommended features"
			contextSummary="From project context"
			changes={CHANGES}
			hasPMTool={false}
			projectId="project_1"
			onApprove={onApprove}
			onReject={vi.fn()}
			lockedIndexes={new Set([1])}
			allowKindOverride={false}
			allowInReviewDrafting={false}
			{...props}
		/>,
	);
	return { onApprove };
}

describe("BacklogChangeProposal — locked (already accepted) rows", () => {
	it("announces a locked row as accepted, in text, with a disabled checkbox", () => {
		renderBatch();
		const locked = screen.getByRole("checkbox", {
			name: "Bravo (already accepted)",
		});
		expect(locked).toBeDisabled();
		expect(locked).not.toBeChecked();
		expect(screen.getByText("Accepted")).toBeInTheDocument();
		expect(
			screen.getByRole("checkbox", { name: "Toggle Alpha" }),
		).toBeChecked();
	});

	it("never submits a locked row", async () => {
		const user = userEvent.setup();
		const { onApprove } = renderBatch();
		await user.click(
			screen.getByRole("button", { name: /Apply Selected/ }),
		);
		await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
		const submitted = onApprove.mock.calls[0]?.[0] as ChangeItem[];
		expect(submitted.map((c) => c.title.to)).toEqual(["Alpha", "Charlie"]);
	});

	it("drops a locked row from a stale persisted selection", async () => {
		window.localStorage.setItem(
			"fabric.backlog-change-proposal.review-state.proposal:stale",
			JSON.stringify({ v: 2, selected: [0, 1, 2], reviewed: [] }),
		);
		const user = userEvent.setup();
		const { onApprove } = renderBatch({
			persistenceKey: "proposal:stale",
		});
		await user.click(
			screen.getByRole("button", { name: /Apply Selected/ }),
		);
		await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
		const submitted = onApprove.mock.calls[0]?.[0] as ChangeItem[];
		expect(submitted.map((c) => c.title.to)).not.toContain("Bravo");
	});

	it("labels a duplicate-skipped row 'Already on Roadmap', not 'Accepted'", () => {
		renderBatch({
			lockedIndexes: new Set([0, 1]),
			lockedReasons: new Map([[1, "already-on-roadmap"]]),
		});
		expect(
			screen.getByRole("checkbox", { name: "Alpha (already accepted)" }),
		).toBeDisabled();
		expect(
			screen.getByRole("checkbox", {
				name: "Bravo (already on the Roadmap)",
			}),
		).toBeDisabled();
		expect(screen.getAllByText("Accepted")).toHaveLength(1);
		expect(screen.getByText("Already on Roadmap")).toBeInTheDocument();
	});

	it("reopens a returned batch with every unlocked row selected, not the stored pre-apply pick", () => {
		// Accepted Alpha alone, so the stored selection is exactly the row
		// that is now locked.
		window.localStorage.setItem(
			"fabric.backlog-change-proposal.review-state.proposal:returned",
			JSON.stringify({ v: 2, selected: [0], reviewed: [] }),
		);
		renderBatch({
			persistenceKey: "proposal:returned",
			lockedIndexes: new Set([0]),
		});
		expect(
			screen.getByRole("checkbox", { name: "Toggle Bravo" }),
		).toBeChecked();
		expect(
			screen.getByRole("checkbox", { name: "Toggle Charlie" }),
		).toBeChecked();
	});

	it("keeps a second-pass selection made after the batch came back", () => {
		window.localStorage.setItem(
			"fabric.backlog-change-proposal.review-state.proposal:second-pass",
			JSON.stringify({ v: 2, selected: [2], reviewed: [] }),
		);
		renderBatch({
			persistenceKey: "proposal:second-pass",
			lockedIndexes: new Set([0]),
		});
		expect(
			screen.getByRole("checkbox", { name: "Toggle Bravo" }),
		).not.toBeChecked();
		expect(
			screen.getByRole("checkbox", { name: "Toggle Charlie" }),
		).toBeChecked();
	});

	it("selects and deselects every unlocked row at once", async () => {
		const user = userEvent.setup();
		const { onApprove } = renderBatch({ showSelectAll: true });
		expect(screen.getByText("2 of 2 selected")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Deselect all" }));
		expect(
			screen.getByRole("checkbox", { name: "Toggle Alpha" }),
		).not.toBeChecked();
		expect(
			screen.getByRole("checkbox", { name: "Toggle Charlie" }),
		).not.toBeChecked();
		expect(screen.getByText("0 of 2 selected")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Select all" }));
		await user.click(
			screen.getByRole("button", { name: /Apply Selected/ }),
		);
		await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
		const submitted = onApprove.mock.calls[0]?.[0] as ChangeItem[];
		expect(submitted.map((c) => c.title.to)).toEqual(["Alpha", "Charlie"]);
	});

	it("shows no select-all control unless asked", () => {
		renderBatch();
		expect(
			screen.queryByRole("button", { name: /Select all|Deselect all/ }),
		).toBeNull();
	});

	it("offers no Bug/Feature choice when kind override is off", () => {
		renderBatch();
		expect(screen.queryByRole("radiogroup")).toBeNull();
		expect(screen.getAllByText("feature")).toHaveLength(3);
	});

	it("keeps the Bug/Feature choice by default", () => {
		renderBatch({
			lockedIndexes: undefined,
			allowKindOverride: undefined,
			allowInReviewDrafting: undefined,
		});
		expect(screen.getAllByRole("radiogroup")).toHaveLength(3);
	});

	it.each([
		[false, 0],
		[true, 1],
	])(
		"with in-review drafting %s, opening a row drafts it %i time(s)",
		async (allowInReviewDrafting, calls) => {
			reformatMock.mockReset();
			reformatMock.mockResolvedValue({ description: "Drafted." });
			const user = userEvent.setup();
			renderBatch({ allowInReviewDrafting });
			const [firstOpen] = screen.getAllByRole("button", {
				name: /Open full detail to review/,
			});
			if (!firstOpen) {
				throw new Error("no detail button");
			}
			await user.click(firstOpen);
			await waitFor(() =>
				expect(reformatMock).toHaveBeenCalledTimes(calls),
			);
		},
	);
});
