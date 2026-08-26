import { describe, expect, it } from "vitest";
import {
	DOCUMENT_PHASES,
	orderDocsByPhase,
} from "../batch-document-generation";

describe("intra-phase ordering", () => {
	it("phase map places BUSINESS_CASE first in Phase 1", () => {
		expect(DOCUMENT_PHASES.BUSINESS_CASE).toEqual({ phase: 1, order: 0 });
		expect(DOCUMENT_PHASES.PROPOSAL.order).toBeGreaterThan(
			DOCUMENT_PHASES.BUSINESS_CASE.order,
		);
		expect(DOCUMENT_PHASES.PRD.order).toBeGreaterThan(
			DOCUMENT_PHASES.PROPOSAL.order,
		);
		expect(DOCUMENT_PHASES.GENERAL.order).toBeGreaterThan(
			DOCUMENT_PHASES.PRD.order,
		);
	});

	it("orders a mixed Phase-1 batch BC -> Proposal -> PRD -> General", () => {
		const docs = [
			{ id: "g", type: "GENERAL" },
			{ id: "p", type: "PRD" },
			{ id: "b", type: "BUSINESS_CASE" },
			{ id: "pr", type: "PROPOSAL" },
		];
		const phase1 = orderDocsByPhase(docs)
			.get(1)!
			.map((d) => d.type);
		expect(phase1).toEqual(["BUSINESS_CASE", "PROPOSAL", "PRD", "GENERAL"]);
	});
});
