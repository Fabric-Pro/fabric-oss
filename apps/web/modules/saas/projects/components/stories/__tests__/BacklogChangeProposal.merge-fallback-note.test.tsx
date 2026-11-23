/**
 * BacklogChangeProposal — the note on an update whose merge fell back. The
 * analysis keeps the ticket and appends the update's new detail, so the
 * note says the merge failed and where the detail went, never that the
 * description was kept as it was.
 */

import en from "@repo/i18n/translations/en.json";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	BacklogChangeProposal,
	type ChangeItem,
} from "../BacklogChangeProposal";
import { renderWithQueryClient } from "./render-with-query-client";

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
	useBasePath: () => "/app/example-org",
}));

const EXISTING = "## Overview\nSupervisors export the queue as CSV.";

function update(overrides: Partial<ChangeItem> = {}): ChangeItem {
	return {
		type: "feature",
		action: "update",
		existingId: "story_1",
		targetResolution: {
			status: "resolved",
			resolvedIdentifier: "F-2",
			resolvedTitle: "Export",
		},
		title: { from: "Export", to: "Export" },
		description: {
			from: EXISTING,
			to: `${EXISTING}\n\nSupervisors can schedule a nightly export.`,
		},
		reasoning: "Raised in planning",
		sourceContext: "teams_messages",
		...overrides,
	};
}

function renderProposal(change: ChangeItem) {
	return renderWithQueryClient(
		<BacklogChangeProposal
			summary="Test proposal"
			contextSummary="Captured from a Teams thread"
			changes={[change]}
			projectId="proj_1"
			hasPMTool={false}
			onApprove={vi.fn()}
			onReject={vi.fn()}
		/>,
	);
}

describe("BacklogChangeProposal — merge fallback note", () => {
	it("says the merge failed and the new detail was added at the end", () => {
		renderProposal(update({ bodyMergeFallback: true }));

		// The global next-intl mock renders the key.
		expect(
			screen.getByText("backlogProposalMergeFallback"),
		).toBeInTheDocument();
		expect(
			screen.queryByText(/kept the existing description/),
		).not.toBeInTheDocument();
		const copy = en.tooltips.stories.backlogProposalMergeFallback;
		expect(copy).toMatch(/couldn't merge/);
		expect(copy).toMatch(/added at the end, unchanged/);
	});

	it("shows no note when the merge did not fall back", () => {
		renderProposal(update());

		expect(
			screen.queryByText("backlogProposalMergeFallback"),
		).not.toBeInTheDocument();
	});
});
