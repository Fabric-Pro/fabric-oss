/**
 * Deterministic pre-rule matrix for delivery-track classification.
 *
 * Plan Slice 2: DEFER only for explicit out-of-scope markers, low-priority
 * items outside a configured quoted horizon, or deferred dependencies. A
 * phase label alone never defers (EST-03 is Phase 2 and must NOT defer).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
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

	/**
	 * The generated feature template has a "### Out of Scope" section listing
	 * what the item will NOT do. Its heading and bullets used to defer every
	 * templated story ("Marked out of scope in the title or description").
	 */
	it("ignores the template's Out of Scope section — it lists sub-items, not the item", () => {
		const description = [
			"## Scope",
			"",
			"### In Scope",
			"",
			"-   Send due-date reminder emails to the agreed recipients.",
			"",
			"### Out of Scope",
			"",
			"-   Reminder channels other than email.",
			"-   Recurring reminders are deferred to a later release.",
			"",
			"#### Excluded integrations",
			"",
			"-   Calendar sync.",
			"",
			"## Key Decisions",
			"",
			"-   The reminder channel is email.",
		].join("\n");
		const result = applyDeterministicTrackRules(
			story({
				title: "Add email reminders for tasks due tomorrow",
				description,
			}),
			{ quotedPhases: [] },
		);
		expect("track" in result).toBe(false);
	});

	it("still defers on a marker in the body after an Out of Scope section closes", () => {
		const description = [
			"### Out of Scope",
			"",
			"-   Reminder channels other than email.",
			"",
			"## Status",
			"",
			"This whole item is out of scope for the current engagement.",
		].join("\n");
		const result = applyDeterministicTrackRules(story({ description }), {
			quotedPhases: [],
		});
		expect(result).toMatchObject({ track: "DEFER" });
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

describe("applyDeterministicTrackRules — open questions never defer", () => {
	// The drafted-spec shape of the story QA saw deferred: the sections a
	// fresh spec carries, with deferral words only inside the undecided ones.
	const draftedSpec = [
		"## Overview",
		"Show each story's delivery track on the board.",
		"## Dependencies / Risks",
		"- Depends on the Product decision about track colours; may be excluded from v1.",
		"## Open Questions / Needed Decisions",
		"- Should the track badge be deferred to the next release?",
		"- Which tracks are excluded from the summary?",
		"## Assumptions",
		"- Deferred items are hidden by default.",
	].join("\n");

	it("the 10/9 drafted-spec story is not deferred by its open questions", () => {
		const result = applyDeterministicTrackRules(
			story({ title: "QA #1027 track check", description: draftedSpec }),
			{ quotedPhases: [] },
		);
		expect("track" in result).toBe(false);
		expect(result).toEqual({ candidate: null });
	});

	it("an out-of-scope marker outside the question sections still defers", () => {
		const result = applyDeterministicTrackRules(
			story({
				title: "QA #1027 track check",
				description: `This story is out of scope for this engagement.\n${draftedSpec}`,
			}),
			{ quotedPhases: [] },
		);
		expect(result).toMatchObject({ track: "DEFER" });
	});

	it("a deferral under a later, unrelated heading is still read", () => {
		const result = applyDeterministicTrackRules(
			story({
				description: `${draftedSpec}\n## Status\nDeferred until phase 3.`,
			}),
			{ quotedPhases: [] },
		);
		expect(result).toMatchObject({ track: "DEFER" });
	});
});

describe("applyDeterministicTrackRules — scope boundaries inside the spec never defer", () => {
	// Verbatim description of the drafted-spec story QA saw deferred on 10/12:
	// "…tasks outside the next-day boundary are excluded." under a use case.
	const stagingSpec = readFileSync(
		path.join(
			__dirname,
			"fixtures",
			"delivery-track-scope-boundary-spec.txt",
		),
		"utf-8",
	);

	it("the 10/12 drafted-spec story is not deferred by a use-case exclusion", () => {
		const result = applyDeterministicTrackRules(
			story({
				title: "QA #1053 open questions",
				description: stagingSpec,
			}),
			{ quotedPhases: [] },
		);
		expect("track" in result).toBe(false);
	});

	it("a plain statement that the story is out of scope still defers", () => {
		const result = applyDeterministicTrackRules(
			story({
				description:
					"Out of scope for this release — parked until next quarter.",
			}),
			{ quotedPhases: [] },
		);
		expect(result).toMatchObject({ track: "DEFER" });
	});

	it("a marker in the title still defers a fully drafted spec", () => {
		const result = applyDeterministicTrackRules(
			story({
				title: "[Out of scope] Due-date email reminders",
				description: stagingSpec,
			}),
			{ quotedPhases: [] },
		);
		expect(result).toMatchObject({ track: "DEFER" });
	});

	it("a status line in the description still defers", () => {
		const result = applyDeterministicTrackRules(
			story({ description: `**Status:** Parked\n\n${stagingSpec}` }),
			{ quotedPhases: [] },
		);
		expect(result).toMatchObject({ track: "DEFER" });
	});

	it("an inline Out of scope / Deferred sub-feature list does not defer", () => {
		const description = [
			"Send an email when a task is due tomorrow.",
			"",
			"**Out of scope:** SMS and push reminders.",
			"Deferred: recurring reminders and digest emails.",
			"",
			"Excluded:",
			"- Calendar sync.",
		].join("\n");
		const result = applyDeterministicTrackRules(story({ description }), {
			quotedPhases: [],
		});
		expect("track" in result).toBe(false);
	});

	it("prose excluding part of the behaviour does not defer", () => {
		const result = applyDeterministicTrackRules(
			story({
				description:
					"Reminders cover tasks due tomorrow. Undated tasks are excluded, and overdue tasks are not in scope.",
			}),
			{ quotedPhases: [] },
		);
		expect("track" in result).toBe(false);
	});

	it("a use case or requirement section is never read for the item's status", () => {
		const description = [
			"## Use Cases",
			"",
			"### UC1: Reschedule a reminder",
			"",
			"- Edge case: the feature is deferred for archived projects.",
			"",
			"## Acceptance Criteria",
			"",
			"- Out of scope for this release: reminders for overdue tasks.",
		].join("\n");
		const result = applyDeterministicTrackRules(story({ description }), {
			quotedPhases: [],
		});
		expect("track" in result).toBe(false);
	});
});

describe("delivery-track adversarial headings", () => {
	it.each([" ", "\t"])(
		"bounds heading matching with repeated %j and an embedded line separator",
		(space) => {
			const start = performance.now();
			expect(
				applyDeterministicTrackRules(
					story({ description: `##${space.repeat(80_000)}x\u2028x` }),
					{ quotedPhases: [] },
				),
			).toEqual({ candidate: null });
			expect(performance.now() - start).toBeLessThan(500);
		},
	);

	it("excludes tab-separated scope headings with trailing whitespace", () => {
		expect(
			applyDeterministicTrackRules(
				story({
					description:
						"###\t Out of Scope \t\nThis story is deferred.\n##\t Summary\nImplement totals.",
				}),
				{ quotedPhases: [] },
			),
		).toEqual({ candidate: null });
	});
});
