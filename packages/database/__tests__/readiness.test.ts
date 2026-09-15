/**
 * Readiness policy matrix (plan §1.1 / Slice 5, fail-closed first).
 *
 * `evaluateReadiness` is pure; every case pins which gaps block (flag on)
 * versus which are advisory (flag off).
 */

import { describe, expect, it } from "vitest";
import {
	evaluateReadiness,
	type ReadinessEnforcement,
	type ReadinessInput,
	resolveEffectiveTrack,
} from "../src/delivery/readiness";

const ALL_OFF: ReadinessEnforcement = {
	specify: false,
	spike: false,
	discovery: false,
};
const ALL_ON: ReadinessEnforcement = {
	specify: true,
	spike: true,
	discovery: true,
};

const NO_EVIDENCE = {
	acceptedSpikeRuns: 0,
	integrationContractComplete: false,
};

function input(
	overrides: Omit<Partial<ReadinessInput>, "story"> & {
		story?: Partial<ReadinessInput["story"]>;
	},
): ReadinessInput {
	return {
		story: {
			deliveryTrack: "SPECIFY",
			description: "Some description",
			acceptanceCriteria: "Given/When/Then",
			...overrides.story,
		},
		profile: overrides.profile ?? "PROPOSAL",
		enforcement: overrides.enforcement ?? ALL_OFF,
		evidence: overrides.evidence ?? NO_EVIDENCE,
	};
}

describe("evaluateReadiness — SPECIFY", () => {
	it("blocks on missing acceptance criteria when the specify flag is on", () => {
		const result = evaluateReadiness(
			input({
				story: { acceptanceCriteria: null },
				enforcement: { ...ALL_OFF, specify: true },
			}),
		);
		expect(result.ready).toBe(false);
		expect(result.missing).toEqual(["ACCEPTANCE_CRITERIA_MISSING"]);
		expect(result.advisory).toEqual([]);
	});

	it("is advisory on missing acceptance criteria when the specify flag is off", () => {
		const result = evaluateReadiness(
			input({ story: { acceptanceCriteria: "" }, enforcement: ALL_OFF }),
		);
		expect(result.ready).toBe(true);
		expect(result.missing).toEqual([]);
		expect(result.advisory).toEqual(["ACCEPTANCE_CRITERIA_MISSING"]);
	});

	it("reports description and acceptance criteria gaps together, in stable order", () => {
		const result = evaluateReadiness(
			input({
				story: { description: null, acceptanceCriteria: null },
				enforcement: { ...ALL_OFF, specify: true },
			}),
		);
		expect(result.missing).toEqual([
			"DESCRIPTION_MISSING",
			"ACCEPTANCE_CRITERIA_MISSING",
		]);
	});

	it("is ready with description and acceptance criteria present", () => {
		const result = evaluateReadiness(input({ enforcement: ALL_ON }));
		expect(result.ready).toBe(true);
		expect(result.missing).toEqual([]);
		expect(result.advisory).toEqual([]);
	});
});

describe("evaluateReadiness — SPIKE", () => {
	it("blocks without an accepted spike run only when the spike flag is on", () => {
		const blocked = evaluateReadiness(
			input({
				story: { deliveryTrack: "SPIKE" },
				enforcement: { ...ALL_OFF, spike: true },
			}),
		);
		expect(blocked.ready).toBe(false);
		expect(blocked.missing).toEqual(["SPIKE_NOT_ACCEPTED"]);

		const advisory = evaluateReadiness(
			input({ story: { deliveryTrack: "SPIKE" }, enforcement: ALL_OFF }),
		);
		expect(advisory.ready).toBe(true);
		expect(advisory.advisory).toEqual(["SPIKE_NOT_ACCEPTED"]);
	});

	it("passes with an accepted spike run and content", () => {
		const result = evaluateReadiness(
			input({
				story: { deliveryTrack: "SPIKE" },
				enforcement: ALL_ON,
				evidence: {
					acceptedSpikeRuns: 1,
					integrationContractComplete: false,
				},
			}),
		);
		expect(result.ready).toBe(true);
	});

	it("still requires content under the specify flag after the spike is accepted", () => {
		const result = evaluateReadiness(
			input({
				story: { deliveryTrack: "SPIKE", acceptanceCriteria: null },
				enforcement: ALL_ON,
				evidence: {
					acceptedSpikeRuns: 1,
					integrationContractComplete: false,
				},
			}),
		);
		expect(result.ready).toBe(false);
		expect(result.missing).toEqual(["ACCEPTANCE_CRITERIA_MISSING"]);
	});
});

describe("evaluateReadiness — DISCOVERY", () => {
	it("blocks without a complete integration contract only when the discovery flag is on", () => {
		const blocked = evaluateReadiness(
			input({
				story: { deliveryTrack: "DISCOVERY" },
				enforcement: { ...ALL_OFF, discovery: true },
			}),
		);
		expect(blocked.ready).toBe(false);
		expect(blocked.missing).toEqual(["INTEGRATION_CONTRACT_MISSING"]);

		const advisory = evaluateReadiness(
			input({
				story: { deliveryTrack: "DISCOVERY" },
				enforcement: ALL_OFF,
			}),
		);
		expect(advisory.ready).toBe(true);
		expect(advisory.advisory).toEqual(["INTEGRATION_CONTRACT_MISSING"]);
	});

	it("passes with a complete contract and content", () => {
		const result = evaluateReadiness(
			input({
				story: { deliveryTrack: "DISCOVERY" },
				enforcement: ALL_ON,
				evidence: {
					acceptedSpikeRuns: 0,
					integrationContractComplete: true,
				},
			}),
		);
		expect(result.ready).toBe(true);
	});
});

describe("evaluateReadiness — DEFER", () => {
	it("always blocks, regardless of flags or content", () => {
		for (const enforcement of [ALL_OFF, ALL_ON]) {
			const result = evaluateReadiness(
				input({ story: { deliveryTrack: "DEFER" }, enforcement }),
			);
			expect(result.ready).toBe(false);
			expect(result.missing).toEqual(["DEFERRED"]);
			expect(result.effectiveTrack).toBe("DEFER");
		}
	});

	it("does not resolve DEFER to another track under GOVERNED", () => {
		const result = evaluateReadiness(
			input({ story: { deliveryTrack: "DEFER" }, profile: "GOVERNED" }),
		);
		expect(result.effectiveTrack).toBe("DEFER");
		expect(result.ready).toBe(false);
	});
});

describe("evaluateReadiness — UNCLASSIFIED", () => {
	it("is advisory when no flag is on", () => {
		const result = evaluateReadiness(
			input({
				story: { deliveryTrack: "UNCLASSIFIED" },
				enforcement: ALL_OFF,
			}),
		);
		expect(result.ready).toBe(true);
		expect(result.advisory).toEqual(["UNCLASSIFIED"]);
	});

	it("blocks when any single flag is on", () => {
		for (const flag of ["specify", "spike", "discovery"] as const) {
			const result = evaluateReadiness(
				input({
					story: { deliveryTrack: "UNCLASSIFIED" },
					enforcement: { ...ALL_OFF, [flag]: true },
				}),
			);
			expect(result.ready, `flag ${flag}`).toBe(false);
			expect(result.missing).toEqual(["UNCLASSIFIED"]);
		}
	});

	it("resolves to SPECIFY under GOVERNED and evaluates the SPECIFY gate", () => {
		expect(resolveEffectiveTrack("UNCLASSIFIED", "GOVERNED")).toBe(
			"SPECIFY",
		);
		expect(resolveEffectiveTrack("UNCLASSIFIED", "PROPOSAL")).toBe(
			"UNCLASSIFIED",
		);

		const result = evaluateReadiness(
			input({
				story: {
					deliveryTrack: "UNCLASSIFIED",
					acceptanceCriteria: null,
				},
				profile: "GOVERNED",
				enforcement: { ...ALL_OFF, specify: true },
			}),
		);
		expect(result.effectiveTrack).toBe("SPECIFY");
		expect(result.missing).toEqual(["ACCEPTANCE_CRITERIA_MISSING"]);
		expect(result.missing).not.toContain("UNCLASSIFIED");
	});
});

describe("evaluateReadiness — fail closed", () => {
	it("blocks when evidence is unavailable even with every flag off and content present", () => {
		const result = evaluateReadiness(
			input({
				enforcement: ALL_OFF,
				evidence: { ...NO_EVIDENCE, evidenceUnavailable: true },
			}),
		);
		expect(result.ready).toBe(false);
		expect(result.missing[0]).toBe("EVIDENCE_UNAVAILABLE");
	});

	it("treats TipTap JSON with no text as blank content", () => {
		const emptyDoc = JSON.stringify({
			type: "doc",
			content: [
				{ type: "paragraph", content: [] },
				{ type: "paragraph" },
			],
		});
		const result = evaluateReadiness(
			input({
				story: { description: emptyDoc, acceptanceCriteria: emptyDoc },
				enforcement: { ...ALL_OFF, specify: true },
			}),
		);
		expect(result.ready).toBe(false);
		expect(result.missing).toEqual([
			"DESCRIPTION_MISSING",
			"ACCEPTANCE_CRITERIA_MISSING",
		]);
	});

	it("treats TipTap JSON with nested text as content", () => {
		const doc = JSON.stringify({
			type: "doc",
			content: [
				{
					type: "bulletList",
					content: [
						{
							type: "listItem",
							content: [
								{
									type: "paragraph",
									content: [
										{ type: "text", text: "Given a user" },
									],
								},
							],
						},
					],
				},
			],
		});
		const result = evaluateReadiness(
			input({
				story: { description: doc, acceptanceCriteria: doc },
				enforcement: { ...ALL_OFF, specify: true },
			}),
		);
		expect(result.ready).toBe(true);
	});

	it("treats whitespace-only text as blank", () => {
		const result = evaluateReadiness(
			input({
				story: { description: "   \n\t", acceptanceCriteria: " " },
				enforcement: { ...ALL_OFF, specify: true },
			}),
		);
		expect(result.missing).toEqual([
			"DESCRIPTION_MISSING",
			"ACCEPTANCE_CRITERIA_MISSING",
		]);
	});
});
