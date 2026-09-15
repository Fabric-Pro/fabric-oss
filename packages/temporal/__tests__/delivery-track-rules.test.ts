/**
 * Deterministic pre-rule matrix for delivery-track classification.
 *
 * Plan Slice 2: DEFER only for explicit out-of-scope markers, low-priority
 * items outside a configured quoted horizon, or deferred dependencies. A
 * phase label alone never defers (EST-03 is Phase 2 and must NOT defer).
 */
import { describe, expect, it } from "vitest";
import {
	applyDeterministicTrackRules,
	getPhaseLabel,
	type TrackRuleStory,
} from "../src/activities/delivery-track/classify";

function story(overrides: Partial<TrackRuleStory> = {}): TrackRuleStory {
	return {
		id: "s1",
		title: "Estimate roll-up per phase",
		description: "Sum story points per phase and show totals.",
		priority: "P2_MEDIUM",
		labels: [],
		dependsOnRefs: [],
		sourceRef: null,
		...overrides,
	};
}

describe("getPhaseLabel", () => {
	it("extracts the phase number from a phase:N label", () => {
		expect(getPhaseLabel(["area:billing", "phase:2"])).toBe("2");
		expect(getPhaseLabel(["Phase:3"])).toBe("3");
	});

	it("returns null when no phase label exists", () => {
		expect(getPhaseLabel(["area:billing"])).toBeNull();
		expect(getPhaseLabel([])).toBeNull();
	});
});

describe("applyDeterministicTrackRules — DEFER rules", () => {
	it("EST-03-like: phase 2, P1_HIGH, quotedPhases [1] → NOT deferred", () => {
		const result = applyDeterministicTrackRules(
			story({ labels: ["phase:2"], priority: "P1_HIGH" }),
			{ quotedPhases: ["1"] },
		);
		expect("track" in result).toBe(false);
		expect(result).toEqual({ candidate: null });
	});

	it("PRJ-04-like: phase 3, P3_LOW, quotedPhases [1] → DEFER", () => {
		const result = applyDeterministicTrackRules(
			story({
				title: "Project archive view",
				description: "Nice to have list of archived projects.",
				labels: ["phase:3"],
				priority: "P3_LOW",
			}),
			{ quotedPhases: ["1"] },
		);
		expect(result).toMatchObject({ track: "DEFER" });
		expect((result as { rationale: string }).rationale).toMatch(
			/outside the quoted horizon/i,
		);
	});

	it("PRJ-04-like with empty quotedPhases → NOT deferred (no horizon configured)", () => {
		const result = applyDeterministicTrackRules(
			story({
				title: "Project archive view",
				description: "Nice to have list of archived projects.",
				labels: ["phase:3"],
				priority: "P3_LOW",
			}),
			{ quotedPhases: [] },
		);
		expect("track" in result).toBe(false);
	});

	it("phase outside the horizon but P2_MEDIUM → NOT deferred", () => {
		const result = applyDeterministicTrackRules(
			story({ labels: ["phase:3"], priority: "P2_MEDIUM" }),
			{ quotedPhases: ["1"] },
		);
		expect("track" in result).toBe(false);
	});

	it("phase inside the horizon and P3_LOW → NOT deferred", () => {
		const result = applyDeterministicTrackRules(
			story({ labels: ["phase:1"], priority: "P3_LOW" }),
			{ quotedPhases: ["1", "2"] },
		);
		expect("track" in result).toBe(false);
	});

	it("'out of scope' in the title → DEFER regardless of phase or priority", () => {
		const result = applyDeterministicTrackRules(
			story({
				title: "Mobile app (out of scope)",
				labels: ["phase:1"],
				priority: "P0_CRITICAL",
			}),
			{ quotedPhases: ["1"] },
		);
		expect(result).toMatchObject({ track: "DEFER" });
	});

	it("'not in scope' / 'excluded' / 'deferred' in the description → DEFER", () => {
		for (const marker of ["not in scope", "Excluded", "deferred"]) {
			const result = applyDeterministicTrackRules(
				story({ description: `This item is ${marker} for now.` }),
				{ quotedPhases: [] },
			);
			expect(result, marker).toMatchObject({ track: "DEFER" });
		}
	});

	it("does not treat substrings such as 'excludedFlag' as a marker", () => {
		const result = applyDeterministicTrackRules(
			story({ description: "Set excludedFlag=false on import." }),
			{ quotedPhases: [] },
		);
		expect("track" in result).toBe(false);
	});

	it("depends on a deferred sourceRef → DEFER", () => {
		const result = applyDeterministicTrackRules(
			story({ dependsOnRefs: ["VIS-02"] }),
			{ quotedPhases: [] },
			{ deferredRefs: new Set(["VIS-02"]) },
		);
		expect(result).toMatchObject({ track: "DEFER" });
		expect((result as { rationale: string }).rationale).toContain("VIS-02");
	});

	it("depends on a non-deferred sourceRef → NOT deferred", () => {
		const result = applyDeterministicTrackRules(
			story({ dependsOnRefs: ["VIS-01"] }),
			{ quotedPhases: [] },
			{ deferredRefs: new Set(["VIS-02"]) },
		);
		expect("track" in result).toBe(false);
	});
});

describe("applyDeterministicTrackRules — DISCOVERY candidates", () => {
	it("'SSO and identity' → candidate DISCOVERY (model confirms)", () => {
		const result = applyDeterministicTrackRules(
			story({
				title: "SSO and identity provider login",
				description: "Let users sign in with the corporate IdP.",
			}),
			{ quotedPhases: [] },
		);
		expect(result).toEqual({ candidate: "DISCOVERY" });
	});

	it("keyword hits in the description only → candidate DISCOVERY", () => {
		for (const keyword of [
			"oauth",
			"authorization",
			"permission",
			"tenant",
			"ERP",
			"webhook",
			"PII",
			"GDPR",
			"HIPAA",
			"payment",
			"billing",
		]) {
			const result = applyDeterministicTrackRules(
				story({
					title: "Plain feature",
					description: `Touches ${keyword} handling.`,
				}),
				{ quotedPhases: [] },
			);
			expect(result, keyword).toEqual({ candidate: "DISCOVERY" });
		}
	});

	it("deterministic rules with no hits → candidate null", () => {
		const result = applyDeterministicTrackRules(
			story({
				title: "Sort the estimate table by phase",
				description:
					"Click a column header to sort ascending/descending.",
			}),
			{ quotedPhases: [] },
		);
		expect(result).toEqual({ candidate: null });
	});

	it("out-of-scope wins over a DISCOVERY keyword", () => {
		const result = applyDeterministicTrackRules(
			story({
				title: "SSO login — out of scope for this engagement",
			}),
			{ quotedPhases: [] },
		);
		expect(result).toMatchObject({ track: "DEFER" });
	});
});
