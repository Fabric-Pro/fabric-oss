/**
 * BacklogChangeProposal — markdown is stripped in the clamped list previews.
 *
 * The list rows are `line-clamp-2` previews; rendering block-level markdown
 * there would blow out the two-line layout, so the create-description and
 * reasoning previews run through `stripMarkdown` (AC3). Full rendering happens
 * in the detail dialog (see BacklogChangeDetailDialog.test.tsx).
 */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	BacklogChangeProposal,
	type ChangeItem,
} from "../BacklogChangeProposal";

const h = vi.hoisted(() => ({
	trackEvent: vi.fn(),
	basePath: "/app/acme",
}));

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
	useAnalytics: () => ({ trackEvent: h.trackEvent }),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	useBasePath: () => h.basePath,
}));

function renderProposal(
	props: Partial<React.ComponentProps<typeof BacklogChangeProposal>> = {},
) {
	return render(
		<BacklogChangeProposal
			summary="Test proposal"
			contextSummary="Captured from a Teams thread"
			changes={props.changes ?? []}
			projectId="proj_1"
			hasPMTool={false}
			onApprove={vi.fn()}
			onReject={vi.fn()}
			{...props}
		/>,
	);
}

const markdownCreate: ChangeItem = {
	type: "bug",
	action: "create",
	title: { to: "Doc update bug" },
	description: {
		to: "**Steps to Reproduce** open a document and request an update",
	},
	reasoning: "## Context\nRaised by the reporter in Teams.",
	sourceContext: "teams_messages",
};

beforeEach(() => {
	h.basePath = "/app/acme";
	h.trackEvent.mockClear();
});

describe("BacklogChangeProposal — clamped preview markdown strip", () => {
	it("strips markdown from the create-description preview (AC3)", () => {
		renderProposal({ changes: [markdownCreate] });
		expect(
			screen.getByText(
				"Steps to Reproduce open a document and request an update",
			),
		).toBeInTheDocument();
		expect(document.body.textContent ?? "").not.toContain("**");
	});

	it("strips markdown from the reasoning preview (AC3)", () => {
		renderProposal({ changes: [markdownCreate] });
		expect(
			screen.getByText("Context Raised by the reporter in Teams."),
		).toBeInTheDocument();
		// The raw "## " heading marker must not survive in the preview.
		expect(document.body.textContent ?? "").not.toContain("## Context");
	});

	it("strips markdown from the update-path description diff preview (AC3)", () => {
		const markdownUpdate: ChangeItem = {
			type: "feature",
			action: "update",
			existingId: "story_1",
			title: { to: "Doc feature" },
			description: {
				from: "old plain description",
				to: "**Updated** with a new requirement",
			},
			reasoning: "Refined in review.",
			sourceContext: "teams_messages",
		};
		renderProposal({ changes: [markdownUpdate] });
		// The DiffField compact preview must not leak ** for updates either.
		expect(document.body.textContent ?? "").not.toContain("**");
		expect(
			screen.getByText(/Updated with a new requirement/),
		).toBeDefined();
	});
});
