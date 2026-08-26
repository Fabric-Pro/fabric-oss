import { describe, expect, it } from "vitest";
import type { RepoNodeLite } from "../cross-repo";
import {
	buildIntraRepoAiPrompt,
	type IntraRepoData,
	passesIntraConfidence,
	validateIntraEdges,
} from "../intra-repo";

function node(key: string, label = key): RepoNodeLite {
	return { key, label, kind: "MODULE", description: null, filePath: null };
}

function repo(over: Partial<IntraRepoData> = {}): IntraRepoData {
	return {
		analysisId: "a1",
		repoName: "acme-api",
		technicalNodes: [node("m1", "Checkout"), node("m2", "Payments")],
		businessNodes: [node("c1", "Ordering"), node("c2", "Billing")],
		...over,
	};
}

describe("passesIntraConfidence", () => {
	it("drops every low-confidence reference", () => {
		expect(passesIntraConfidence("CALLS", "low")).toBe(false);
		expect(passesIntraConfidence("DEPENDS_ON", "low")).toBe(false);
		expect(passesIntraConfidence("RELATES_TO", "low")).toBe(false);
	});
	it("keeps concrete CALLS / DEPENDS_ON at medium+", () => {
		expect(passesIntraConfidence("CALLS", "medium")).toBe(true);
		expect(passesIntraConfidence("DEPENDS_ON", "medium")).toBe(true);
		expect(passesIntraConfidence("CALLS", "high")).toBe(true);
	});
	it("requires high confidence for the softer RELATES_TO", () => {
		expect(passesIntraConfidence("RELATES_TO", "medium")).toBe(false);
		expect(passesIntraConfidence("RELATES_TO", "high")).toBe(true);
	});
});

describe("buildIntraRepoAiPrompt", () => {
	it("includes both lenses' node keys and the repo name", () => {
		const prompt = buildIntraRepoAiPrompt(repo());
		expect(prompt).toContain("acme-api");
		expect(prompt).toContain("key=m1");
		expect(prompt).toContain("key=c2");
		expect(prompt).toContain("TECHNICAL modules");
		expect(prompt).toContain("BUSINESS capabilities");
		// Precision guardrails must be present.
		expect(prompt).toMatch(/superficial similarity/i);
		expect(prompt).toMatch(
			/never link a TECHNICAL component to a BUSINESS/i,
		);
	});
});

describe("validateIntraEdges", () => {
	const r = repo();

	it("keeps a valid same-lens reference between real nodes", () => {
		const out = validateIntraEdges(
			[
				{
					sourceKey: "m1",
					targetKey: "m2",
					kind: "CALLS",
					mode: "TECHNICAL",
					confidence: "high",
					rationale: "Checkout calls Payments",
				},
			],
			r,
		);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			mode: "TECHNICAL",
			kind: "CALLS",
			sourceKey: "m1",
			targetKey: "m2",
			description: "Checkout calls Payments",
		});
	});

	it("drops self-loops, hallucinated keys, and cross-lens endpoints", () => {
		const out = validateIntraEdges(
			[
				// self-loop
				{
					sourceKey: "m1",
					targetKey: "m1",
					kind: "CALLS",
					mode: "TECHNICAL",
					confidence: "high",
					rationale: "x",
				},
				// hallucinated key
				{
					sourceKey: "m1",
					targetKey: "ghost",
					kind: "CALLS",
					mode: "TECHNICAL",
					confidence: "high",
					rationale: "x",
				},
				// cross-lens: c1 is a BUSINESS key, not a TECHNICAL one
				{
					sourceKey: "m1",
					targetKey: "c1",
					kind: "CALLS",
					mode: "TECHNICAL",
					confidence: "high",
					rationale: "x",
				},
			],
			r,
		);
		expect(out).toHaveLength(0);
	});

	it("drops weak-confidence references", () => {
		const out = validateIntraEdges(
			[
				{
					sourceKey: "m1",
					targetKey: "m2",
					kind: "RELATES_TO",
					mode: "TECHNICAL",
					confidence: "medium", // RELATES_TO needs high
					rationale: "x",
				},
				{
					sourceKey: "c1",
					targetKey: "c2",
					kind: "CALLS",
					mode: "BUSINESS",
					confidence: "low", // any low dropped
					rationale: "x",
				},
			],
			r,
		);
		expect(out).toHaveLength(0);
	});

	it("dedupes an undirected pair within a (mode, kind)", () => {
		const out = validateIntraEdges(
			[
				{
					sourceKey: "m1",
					targetKey: "m2",
					kind: "CALLS",
					mode: "TECHNICAL",
					confidence: "high",
					rationale: "a",
				},
				{
					sourceKey: "m2",
					targetKey: "m1",
					kind: "CALLS",
					mode: "TECHNICAL",
					confidence: "high",
					rationale: "b",
				},
			],
			r,
		);
		expect(out).toHaveLength(1);
	});

	it("validates BUSINESS-lens references against BUSINESS keys", () => {
		const out = validateIntraEdges(
			[
				{
					sourceKey: "c1",
					targetKey: "c2",
					kind: "RELATES_TO",
					mode: "BUSINESS",
					confidence: "high",
					rationale: "Ordering shares the cart entity with Billing",
				},
			],
			r,
		);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ mode: "BUSINESS", kind: "RELATES_TO" });
	});
});
