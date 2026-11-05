import { describe, expect, it } from "vitest";
import {
	allRelationships,
	buildRelationshipIndex,
	type DecisionLite,
} from "../relationships";

function decision(overrides: Partial<DecisionLite> & { id: string }) {
	return {
		identifier: overrides.id.toUpperCase(),
		title: overrides.id,
		status: "ACCEPTED",
		...overrides,
	} satisfies DecisionLite;
}

describe("allRelationships", () => {
	it("lists a decision it supersedes once, not again as related", () => {
		const old = decision({
			id: "old",
			status: "SUPERSEDED",
			supersededById: "update",
		});
		const other = decision({ id: "other" });
		const update = decision({
			id: "update",
			relatedDecisionIds: ["old", "other"],
		});

		const rels = allRelationships(
			update,
			buildRelationshipIndex([old, other, update]),
		);

		expect(rels.supersedes.map((ref) => ref.id)).toEqual(["old"]);
		expect(rels.related.map((ref) => ref.id)).toEqual(["other"]);
	});

	it("keeps a related decision that nothing supersedes", () => {
		const target = decision({ id: "target" });
		const update = decision({
			id: "update",
			status: "PROPOSED",
			relatedDecisionIds: ["target"],
		});

		const rels = allRelationships(
			update,
			buildRelationshipIndex([target, update]),
		);

		expect(rels.supersedes).toEqual([]);
		expect(rels.related.map((ref) => ref.id)).toEqual(["target"]);
	});
});
