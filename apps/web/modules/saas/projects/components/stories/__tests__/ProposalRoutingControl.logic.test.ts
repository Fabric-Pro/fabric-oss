/**
 * Pure logic behind the Create-vs-Enrich review row.
 *
 * Two things decided here can corrupt a real ticket, so they are pinned
 * separately from the rendering:
 *
 *  - `routingBlocker` is the single rule the Apply button and the row's inline
 *    message both read. If they ever disagree, a reviewer either sees "select a
 *    ticket" beside an enabled Apply, or an inexplicably dead button.
 *  - `applyRoutingOverride` builds the payload. Re-targeting an enrichment must
 *    re-submit the action item AS CAPTURED, never the body the backend already
 *    merged for the ticket the system originally picked — that body belongs to
 *    a different ticket, and apply would write it onto the new one.
 */

import { describe, expect, it } from "vitest";
import {
	applyRoutingOverride,
	type ChangeItem,
} from "../BacklogChangeProposal";
import {
	type RoutingAnnotation,
	type RoutingOverride,
	resolveEffectiveRouting,
	routingBlocker,
} from "../ProposalRoutingControl";

const CAPTURED_TITLE = "Rate limit the export endpoint";
const CAPTURED_DESCRIPTION = "Large exports lock the worker.";

/** A row the backend routed to F-12, as it arrives in the review UI. */
function enrichAnnotation(
	overrides: Partial<RoutingAnnotation> = {},
): RoutingAnnotation {
	return {
		decision: "enrich",
		confidence: 0.9,
		matchedStoryId: "story-1",
		matchedIdentifier: "F-12",
		matchedTitle: "Export throttling",
		proposedTitle: CAPTURED_TITLE,
		proposedDescription: CAPTURED_DESCRIPTION,
		alternatives: [
			{
				storyId: "story-1",
				identifier: "F-12",
				title: "Export throttling",
				similarity: 0.91,
			},
		],
		...overrides,
	};
}

/** The change as the backend hands it over: title and body already F-12's. */
function enrichedChange(routing = enrichAnnotation()): ChangeItem {
	return {
		type: "feature",
		action: "update",
		existingId: "story-1",
		existingIdentifier: "F-12",
		title: { from: "Export throttling", to: "Export throttling" },
		description: {
			from: "Exports need a queue.",
			to: "Exports need a queue.\n\nAlso rate limit the endpoint.",
		},
		reasoning: "Raised twice",
		sourceContext: "meeting_transcript",
		routing,
	};
}

describe("routingBlocker", () => {
	it("does not block a create", () => {
		expect(
			routingBlocker({ decision: "create", confidence: 1 }, undefined),
		).toBeNull();
	});

	it("does not block the system's own enrichment", () => {
		expect(routingBlocker(enrichAnnotation(), undefined)).toBeNull();
	});

	it("blocks a switch to Enrich until a target is chosen", () => {
		const override: RoutingOverride = { decision: "enrich" };
		expect(
			routingBlocker({ decision: "create", confidence: 1 }, override),
		).toBe("target-required");
	});

	it("clears once a target is chosen", () => {
		const override: RoutingOverride = {
			decision: "enrich",
			target: {
				storyId: "story-2",
				identifier: "F-20",
				title: "Other",
				closed: false,
			},
		};
		expect(
			routingBlocker({ decision: "create", confidence: 1 }, override),
		).toBeNull();
	});

	it("blocks a closed target until it is explicitly accepted", () => {
		const closedTarget: RoutingOverride = {
			decision: "enrich",
			target: {
				storyId: "story-3",
				identifier: "F-30",
				title: "Finished work",
				closed: true,
			},
		};
		expect(routingBlocker(enrichAnnotation(), closedTarget)).toBe(
			"closed-target-unconfirmed",
		);
		expect(
			routingBlocker(enrichAnnotation(), {
				...closedTarget,
				closedTargetConfirmed: true,
			}),
		).toBeNull();
	});

	it("blocks a system target that has been closed since the proposal was written", () => {
		// The control installs this override once the live story list shows the
		// matched ticket is closed. Without it, the one path to a closed target
		// that nobody chose would sail through approval.
		const stale: RoutingOverride = {
			decision: "enrich",
			target: {
				storyId: "story-1",
				identifier: "F-12",
				title: "Export throttling",
				closed: true,
			},
			systemTargetWentStale: true,
		};
		expect(routingBlocker(enrichAnnotation(), stale)).toBe(
			"closed-target-unconfirmed",
		);
		// …and it must not be presented as a reviewer decision.
		expect(
			resolveEffectiveRouting(enrichAnnotation(), stale)?.overridden,
		).toBe(false);
	});

	it("ignores routing entirely for a row that has none", () => {
		expect(routingBlocker(undefined, undefined)).toBeNull();
	});
});

describe("applyRoutingOverride", () => {
	it("leaves a row without routing untouched", () => {
		const plain: ChangeItem = {
			type: "feature",
			action: "create",
			title: { to: "Something" },
			reasoning: "",
			sourceContext: "teams_messages",
		};
		expect(applyRoutingOverride(plain, { decision: "enrich" })).toBe(plain);
	});

	it("leaves the row untouched when there is no override", () => {
		const change = enrichedChange();
		expect(applyRoutingOverride(change, undefined)).toBe(change);
	});

	it("re-submits the action item as captured when switching Enrich → Create", () => {
		const result = applyRoutingOverride(enrichedChange(), {
			decision: "create",
		});

		expect(result.action).toBe("create");
		expect(result.existingId).toBeUndefined();
		expect(result.existingIdentifier).toBeUndefined();
		// The row was showing F-12's title and F-12's merged body; a new ticket
		// must carry neither.
		expect(result.title.to).toBe(CAPTURED_TITLE);
		expect(result.description?.to).toBe(CAPTURED_DESCRIPTION);
		expect(result.description?.to).not.toContain("Exports need a queue.");
		expect(result.targetResolution).toBeUndefined();
		expect(result.routing?.decision).toBe("create");
		expect(result.routing?.overridden).toBe(true);
	});

	it("re-targets an enrichment WITHOUT carrying the first ticket's merged body", () => {
		const result = applyRoutingOverride(enrichedChange(), {
			decision: "enrich",
			target: {
				storyId: "story-2",
				identifier: "F-20",
				title: "Bulk export UX",
				closed: false,
			},
		});

		expect(result.action).toBe("update");
		expect(result.existingId).toBe("story-2");
		expect(result.existingIdentifier).toBe("F-20");
		expect(result.title.to).toBe("Bulk export UX");
		// The regression this test exists for: sending the merged body would
		// write F-12's content onto F-20.
		expect(result.description?.to).toBe(CAPTURED_DESCRIPTION);
		expect(result.description?.to).not.toContain("Exports need a queue.");
		// The backend re-resolves the target; a stale stamp would name F-12.
		expect(result.targetResolution).toBeUndefined();
		expect(result.routing?.matchedIdentifier).toBe("F-20");
	});

	it("promotes a create to an enrichment of the chosen ticket", () => {
		const createRow: ChangeItem = {
			type: "feature",
			action: "create",
			title: { to: CAPTURED_TITLE },
			description: { to: CAPTURED_DESCRIPTION },
			reasoning: "Raised twice",
			sourceContext: "meeting_transcript",
			routing: {
				decision: "create",
				confidence: 0.4,
				proposedTitle: CAPTURED_TITLE,
				proposedDescription: CAPTURED_DESCRIPTION,
			},
		};

		const result = applyRoutingOverride(createRow, {
			decision: "enrich",
			target: {
				storyId: "story-9",
				identifier: "F-90",
				title: "Existing work",
				closed: false,
			},
		});

		expect(result.action).toBe("update");
		expect(result.existingId).toBe("story-9");
		expect(result.title.to).toBe("Existing work");
		expect(result.description?.to).toBe(CAPTURED_DESCRIPTION);
	});

	it("stays a create when an Enrich override has no target — never an unaddressed update", () => {
		const createRow: ChangeItem = {
			type: "feature",
			action: "create",
			title: { to: CAPTURED_TITLE },
			reasoning: "",
			sourceContext: "meeting_transcript",
			routing: { decision: "create", confidence: 0.4 },
		};

		const result = applyRoutingOverride(createRow, { decision: "enrich" });

		// The Apply gate should have stopped this, but a payload with
		// `action: "update"` and no target would be resolved by the backend
		// against nothing — silently demoted or, worse, title-matched.
		expect(result.action).toBe("create");
		expect(result.existingId).toBeUndefined();
	});
});
