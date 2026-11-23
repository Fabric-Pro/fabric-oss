/**
 * The summary of an item re-routed to a ticket says what apply writes: a
 * priority or size the target already has is not listed, and a merge that
 * adds none of the item's text says so instead of listing nothing about it.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChangeItem } from "../BacklogChangeProposal";
import {
	type EnrichmentPreview,
	withEnrichmentPreview,
} from "../enrichment-preview";
import { ProposalUpdateSummary } from "../ProposalUpdateSummary";

vi.mock("@shared/lib/orpc-query-utils", () => ({ orpc: {} }));

vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent: vi.fn() }),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	useBasePath: () => "/app/example-org",
}));

const CAPTURED: ChangeItem = {
	type: "feature",
	action: "update",
	existingId: "story-7",
	existingIdentifier: "7",
	title: { to: "Saved filter presets for the board" },
	description: { to: "Save a set of board filters and reapply it later." },
	priority: { to: "P3_LOW" },
	size: { to: "S" },
	reasoning: "Raised in the sync meeting.",
	sourceContext: "meeting_transcript",
};

const UNCHANGED_MERGE: EnrichmentPreview = {
	targetId: "story-7",
	targetIdentifier: "7",
	targetTitle: "Bulk tag editing on the board",
	targetClosed: false,
	currentDescription: "Edit the tags of many board cards at once.",
	currentAcceptanceCriteria: "",
	currentPriority: "P3_LOW",
	currentSize: "S",
	mergedDescription: "Edit the tags of many board cards at once.",
	mergedAcceptanceCriteria: "",
	fallbackUsed: false,
};

describe("ProposalUpdateSummary for a re-routed item", () => {
	it("lists no value the target already has and says the text is not merged", () => {
		render(
			<ProposalUpdateSummary
				change={withEnrichmentPreview(CAPTURED, UNCHANGED_MERGE)}
				keptBodyOn="7"
			/>,
		);

		const summary = screen.getByTestId("proposal-update-summary");
		expect(summary).not.toHaveTextContent("Priority");
		expect(summary).not.toHaveTextContent("Size");
		expect(summary).toHaveTextContent(
			"No field changes: the ticket stays as it is.",
		);
		expect(summary).toHaveTextContent(
			"None of this item's text is merged into 7: its description and acceptance criteria stay as they are.",
		);
	});

	it("lists a value that moves the target", () => {
		render(
			<ProposalUpdateSummary
				change={withEnrichmentPreview(
					{ ...CAPTURED, priority: { to: "P1_HIGH" } },
					UNCHANGED_MERGE,
				)}
			/>,
		);

		const summary = screen.getByTestId("proposal-update-summary");
		expect(summary).toHaveTextContent("Priority — P3_LOW → P1_HIGH");
		expect(summary).not.toHaveTextContent("Size");
	});
});

describe("ProposalUpdateSummary for an update with no from", () => {
	const TICKET = {
		description: [
			"## Overview",
			"Supervisors export the break queue as CSV.",
			"Each export is limited to 10,000 rows.",
			"Each CSV export includes a header row.",
		].join("\n"),
		acceptanceCriteria:
			"1. GIVEN a supervisor  \n   WHEN they export the queue  \n   THEN a CSV downloads.",
	};
	// A whole version of each body: one figure changed, one sentence and one
	// criterion added, with no `from`.
	const UPDATE: ChangeItem = {
		...CAPTURED,
		priority: undefined,
		size: undefined,
		description: {
			to: TICKET.description
				.replace("10,000", "5,000")
				.concat("\nSupervisors can schedule a nightly export."),
		},
		acceptanceCriteria: {
			to: `${TICKET.acceptanceCriteria}\n2. GIVEN a schedule  \n   THEN it runs.`,
		},
	};

	it("counts its change against the ticket as it is, not against an empty body", () => {
		render(<ProposalUpdateSummary change={UPDATE} current={TICKET} />);

		const summary = screen.getByTestId("proposal-update-summary");
		expect(summary).toHaveTextContent(
			"Description · 2 lines added, 1 removed",
		);
		expect(summary).toHaveTextContent(
			"Acceptance criteria · 1 criterion added",
		);
		expect(summary).not.toHaveTextContent("5 lines added");
	});
});
