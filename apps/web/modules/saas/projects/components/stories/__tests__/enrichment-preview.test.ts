/**
 * The update a re-routed inbox item applies is the merge the reviewer was
 * shown, and its approval waits until that merge is read.
 */

import { summarizeProposalUpdate } from "@repo/utils/proposal-update-summary";
import { describe, expect, it, vi } from "vitest";
import type { ChangeItem } from "../BacklogChangeProposal";
import {
	type EnrichmentPreview,
	mergeKeepsTargetBody,
	withEnrichmentPreview,
} from "../enrichment-preview";
import { rerouteSummaryBlockedReason } from "../ProposalItemNotes";

vi.mock("@shared/lib/orpc-query-utils", () => ({ orpc: {} }));

const REROUTED: ChangeItem = {
	type: "feature",
	action: "update",
	existingId: "story-1",
	existingIdentifier: "F-12",
	title: { to: "Rate limit exports" },
	description: { to: "Rate limit exports per user." },
	acceptanceCriteria: { to: "- [ ] Limit applies per user" },
	reasoning: "Same request as F-12.",
	sourceContext: "teams_messages",
};

const PREVIEW: EnrichmentPreview = {
	targetId: "story-1",
	targetIdentifier: "F-12",
	targetTitle: "Export throttling",
	targetClosed: false,
	currentDescription: "Throttle large exports.",
	currentAcceptanceCriteria: "- [ ] Large exports queue",
	currentPriority: "P3_LOW",
	currentSize: "S",
	mergedDescription: "Throttle large exports, per user.",
	mergedAcceptanceCriteria:
		"- [ ] Large exports queue\n- [ ] Limit applies per user",
	fallbackUsed: false,
};

describe("withEnrichmentPreview", () => {
	it("applies the merge against the target as the merge read it", () => {
		const change = withEnrichmentPreview(REROUTED, PREVIEW);

		expect(change.title).toEqual({
			from: "Export throttling",
			to: "Export throttling",
		});
		expect(change.description).toEqual({
			from: "Throttle large exports.",
			to: "Throttle large exports, per user.",
		});
		expect(change.acceptanceCriteria).toEqual({
			from: "- [ ] Large exports queue",
			to: "- [ ] Large exports queue\n- [ ] Limit applies per user",
		});
		expect(change.structurePreserved).toBe(true);
		expect(change.existingId).toBe("story-1");
		expect(change.reasoning).toBe("Same request as F-12.");
	});

	it("leaves the body out when no safe merge exists", () => {
		const change = withEnrichmentPreview(REROUTED, {
			...PREVIEW,
			fallbackUsed: true,
		});

		expect(change.description).toBeUndefined();
		expect(change.acceptanceCriteria).toBeUndefined();
		expect(change.structurePreserved).toBeUndefined();
		expect(change.title).toEqual({
			from: "Export throttling",
			to: "Export throttling",
		});
	});

	it("sets priority and size against the target's, so a value it has is no change", () => {
		const change = withEnrichmentPreview(
			{
				...REROUTED,
				priority: { to: "P3_LOW" },
				size: { to: "M" },
			},
			PREVIEW,
		);

		expect(change.priority).toEqual({ from: "P3_LOW", to: "P3_LOW" });
		expect(change.size).toEqual({ from: "S", to: "M" });
		const lines = summarizeProposalUpdate(change);
		expect(lines.map((line) => line.field)).toEqual([
			"description",
			"acceptanceCriteria",
			"size",
		]);
	});

	it("keeps an item without priority or size free of them", () => {
		const change = withEnrichmentPreview(REROUTED, {
			...PREVIEW,
			currentSize: null,
		});

		expect(change.priority).toBeUndefined();
		expect(change.size).toBeUndefined();
	});
});

describe("mergeKeepsTargetBody", () => {
	const unchanged: EnrichmentPreview = {
		...PREVIEW,
		mergedDescription: PREVIEW.currentDescription,
		mergedAcceptanceCriteria: PREVIEW.currentAcceptanceCriteria,
	};

	it("is true when the merge adds nothing from the item, or none is safe", () => {
		const fallback: EnrichmentPreview = { ...PREVIEW, fallbackUsed: true };

		expect(mergeKeepsTargetBody(unchanged)).toBe(true);
		expect(mergeKeepsTargetBody(fallback)).toBe(true);
	});

	it("is false when the merge changes the description or criteria", () => {
		const criteriaOnly: EnrichmentPreview = {
			...unchanged,
			mergedAcceptanceCriteria: PREVIEW.mergedAcceptanceCriteria,
		};

		expect(mergeKeepsTargetBody(PREVIEW)).toBe(false);
		expect(mergeKeepsTargetBody(criteriaOnly)).toBe(false);
	});
});

describe("rerouteSummaryBlockedReason", () => {
	it("blocks approval while the merge is read or after it failed", () => {
		expect(rerouteSummaryBlockedReason("loading")).toMatch(/Wait for/);
		expect(rerouteSummaryBlockedReason("error")).toMatch(/Try again/);
	});

	it("allows approval once the summary is shown, or for an item not re-routed", () => {
		expect(rerouteSummaryBlockedReason("ready")).toBeNull();
		expect(rerouteSummaryBlockedReason(undefined)).toBeNull();
	});
});
