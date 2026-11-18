import { describe, expect, it } from "vitest";
import {
	type RoutingAnnotation,
	resolveEffectiveRouting,
	routingBlocker,
} from "../ProposalRoutingControl";
import {
	duplicateFlagsByIndex,
	duplicateRoutingAnnotation,
	enrichOverrideFor,
	type ProposalDuplicateStoryMatch,
	similarityPercent,
	withDuplicateRouting,
} from "../proposal-duplicate-flags";

const MATCH: ProposalDuplicateStoryMatch = {
	kind: "story",
	storyId: "story-1",
	identifier: "F-12",
	title: "Export throttling",
	similarity: 0.876,
};

const CHANGE = {
	title: { to: "Queue exports" },
	description: { to: "Exports need a queue." },
};

describe("proposal duplicate flags", () => {
	it("indexes flags by item and drops empty ones", () => {
		const flags = duplicateFlagsByIndex([
			{ changeIndex: 2, matches: [MATCH] },
			{ changeIndex: 4, matches: [] },
		]);

		expect([...flags.keys()]).toEqual([2]);
		expect(flags.get(2)).toEqual([MATCH]);
	});

	it("rounds and clamps the similarity for display", () => {
		expect(similarityPercent(0.876)).toBe(88);
		expect(similarityPercent(1.0000001)).toBe(100);
		expect(similarityPercent(-0.2)).toBe(0);
	});

	it("synthesizes a create annotation from the row's own content, suggesting the match", () => {
		const routing = duplicateRoutingAnnotation(CHANGE, MATCH);

		expect(routing).toMatchObject({
			decision: "create",
			proposedTitle: "Queue exports",
			proposedDescription: "Exports need a queue.",
			proposedAcceptanceCriteria: null,
			alternatives: [
				{
					storyId: "story-1",
					identifier: "F-12",
					title: "Export throttling",
					similarity: 0.876,
				},
			],
		});
		expect(routing.reasoning).toContain("F-12");
	});

	it("routes to an approvable enrichment of the matched ticket", () => {
		const routing = duplicateRoutingAnnotation(CHANGE, MATCH);
		const override = enrichOverrideFor(MATCH);

		expect(resolveEffectiveRouting(routing, override)).toMatchObject({
			decision: "enrich",
			targetStoryId: "story-1",
			targetIdentifier: "F-12",
			overridden: true,
		});
		expect(routingBlocker(routing, override)).toBeNull();
	});

	it("fills only rows without a routing annotation", () => {
		const existing: RoutingAnnotation = {
			decision: "create",
			confidence: 1,
		};
		const synthesized = duplicateRoutingAnnotation(CHANGE, MATCH);
		const rows = [{ routing: existing }, { routing: null }, {}];

		const result = withDuplicateRouting(
			rows,
			new Map([
				[0, synthesized],
				[1, synthesized],
			]),
		);

		expect(result[0]?.routing).toBe(existing);
		expect(result[1]?.routing).toBe(synthesized);
		expect(result[2]).toBe(rows[2]);
	});
});
