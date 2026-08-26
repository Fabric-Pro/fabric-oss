import { buildPublishingPreferencesSnapshot } from "@repo/database";
import { describe, expect, it } from "vitest";
import { buildPublishingPreferencesClause } from "../preferences-clause";

/**
 * The advisory preferences clause (1C-1b part 2, §7.1(a) / FR8–FR10).
 *
 * Pure: snapshot in, string out. Every case builds its snapshot through the
 * REAL `buildPublishingPreferencesSnapshot` rather than hand-writing the
 * object, so the normalization the fingerprint applies is the normalization
 * these assertions see. A hand-built snapshot would let the clause be tested
 * against input the hash never produces.
 */
const empty = buildPublishingPreferencesSnapshot({});

describe("buildPublishingPreferencesClause", () => {
	it("returns the EMPTY STRING when nothing is configured", () => {
		// FR10, and the single most important case in the slice: an unconfigured
		// project's prompt must stay byte-identical to what it was before this
		// feature existed. Satisfied by construction rather than by a branch
		// somewhere downstream that a later edit could get wrong.
		expect(buildPublishingPreferencesClause(empty)).toBe("");
	});

	it("still returns the empty string when only lookbackDays is set", () => {
		// The window is not guidance. It is already applied by the collectors
		// before the model sees anything, so naming it would invite the model to
		// reason about the absence of older material rather than about the
		// material actually present.
		const snapshot = buildPublishingPreferencesSnapshot({
			lookbackDays: 30,
		});
		expect(buildPublishingPreferencesClause(snapshot)).toBe("");
	});

	it("names preferred themes and says nothing about exclusions", () => {
		const clause = buildPublishingPreferencesClause(
			buildPublishingPreferencesSnapshot({
				preferredThemes: [
					"Developer Experience",
					"Release Engineering",
				],
			}),
		);

		expect(clause).toContain("Developer Experience");
		expect(clause).toContain("Release Engineering");
		expect(clause.toLowerCase()).not.toContain("avoid");
	});

	it("phrases exclusions as a prohibition, not as a list of examples", () => {
		// A bare list of keywords reads to a model as a topic list. The framing is
		// the whole difference between suppressing them and requesting them.
		const clause = buildPublishingPreferencesClause(
			buildPublishingPreferencesSnapshot({
				excludedKeywords: ["Roadmap", "Pricing"],
			}),
		);

		expect(clause.toLowerCase()).toContain("avoid");
		expect(clause).toContain("roadmap");
		expect(clause).toContain("pricing");
	});

	it("names post types by their human LABEL, never by the enum constant", () => {
		const clause = buildPublishingPreferencesClause(
			buildPublishingPreferencesSnapshot({
				preferredPostTypes: ["STAKEHOLDER_EMAIL", "BLOG_POST"],
			}),
		);

		expect(clause).toContain("Stakeholder Email");
		expect(clause).toContain("Blog Post");
		expect(clause).not.toContain("STAKEHOLDER_EMAIL");
		expect(clause).not.toContain("BLOG_POST");
	});

	it("omits an unmapped post type rather than printing the raw value", () => {
		// A value the label map does not know is a value a future migration added
		// and this map has not caught up with. Printing it raw would put
		// `SOME_NEW_TYPE` in front of the model and look deliberate.
		const clause = buildPublishingPreferencesClause(
			buildPublishingPreferencesSnapshot({
				preferredPostTypes: ["BLOG_POST", "SOME_NEW_TYPE"],
			}),
		);

		expect(clause).toContain("Blog Post");
		expect(clause).not.toContain("SOME_NEW_TYPE");
	});

	it("carries strategic priorities verbatim, preserving line structure", () => {
		// Line structure is part of the instruction — a three-line list of
		// priorities means something a reflowed paragraph does not.
		const priorities =
			"Ship weekly.\nName the trade-off.\nNo vanity metrics.";
		const clause = buildPublishingPreferencesClause(
			buildPublishingPreferencesSnapshot({
				strategicPriorities: priorities,
			}),
		);

		expect(clause).toContain(priorities);
	});

	it("emits every section when all four are configured", () => {
		const clause = buildPublishingPreferencesClause(
			buildPublishingPreferencesSnapshot({
				preferredThemes: ["Developer Experience"],
				preferredPostTypes: ["BLOG_POST"],
				excludedKeywords: ["Pricing"],
				strategicPriorities: "Ship weekly.",
			}),
		);

		expect(clause).toContain("Developer Experience");
		expect(clause).toContain("Blog Post");
		expect(clause).toContain("pricing");
		expect(clause).toContain("Ship weekly.");
	});

	it("is deterministic for the same snapshot", () => {
		const snapshot = buildPublishingPreferencesSnapshot({
			preferredThemes: ["Beta", "Alpha"],
			strategicPriorities: "Ship weekly.",
		});

		expect(buildPublishingPreferencesClause(snapshot)).toBe(
			buildPublishingPreferencesClause(snapshot),
		);
	});

	it("renders the list exactly as the snapshot settled it — order and case", () => {
		// The snapshot sorts, de-dupes and case-folds where folding was right. A
		// second normalization HERE would be a second place for those rules to
		// drift from the ones the HASH used, so the clause must render what it
		// was given, untouched.
		//
		// Asserted against the SNAPSHOT, not against a second clause. The obvious
		// version of this test — build two snapshots from differently-ordered
		// input and compare their clauses — is tautological: both inputs produce
		// the identical sorted snapshot, so it compares a value with itself and
		// stays green even if the builder reverses and uppercases everything.
		// Measured: that exact break left it passing.
		const snapshot = buildPublishingPreferencesSnapshot({
			preferredThemes: ["beta One", "Alpha Two"],
		});

		expect(buildPublishingPreferencesClause(snapshot)).toContain(
			snapshot.preferredThemes.join(", "),
		);
	});
});
