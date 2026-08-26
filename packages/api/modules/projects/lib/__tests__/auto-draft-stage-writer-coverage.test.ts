/**
 * Coverage guard: every procedure that moves a feature's `draftingStage` must
 * run the test-first auto-draft trigger, or be exempted here on purpose.
 *
 * This exists because the trigger was wired procedure-by-procedure and the
 * enumeration was wrong twice. The first pass covered
 * `stories.updateDraftingStage`; the second added
 * `stories.updateStageWithVersion` and called the set complete. It was not:
 * `stories.update` — the generic save the feature editor's own stage dropdown
 * posts to — and `stories.enhance` also write the field, so a user picking
 * "Ready for Dev" in the editor and pressing Save got no drafting run at all.
 * That is the same symptom the original report raised, through a door nobody
 * had audited.
 *
 * SCOPE, stated because a guard whose reach is assumed is worse than none: this
 * reads `procedures/` only. A Ready-for-Dev writer added under `packages/temporal`
 * or `projects/lib` would not be caught here. Every such writer in the tree was
 * audited when this was written — PM-sync activities write only CLOSED, and every
 * `createStoryFromProposal` caller passes a literal that is not Ready for Dev —
 * so there is no live gap, and this note is what makes the next one findable.
 *
 * A behavioural test cannot catch this class: it proves the procedures it knows
 * about, and the defect is a procedure nobody thought of. So this reads the
 * source and forces a decision for every file. Adding a new procedure that
 * touches `draftingStage` fails here until it either calls the trigger or is
 * listed below with a reason.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PROCEDURES_DIR = join(__dirname, "..", "..", "procedures");

/**
 * Files that mention `draftingStage` but must NOT trigger a drafting run.
 * Every entry needs a reason — "it looked fine" is how the gap got here.
 */
const EXEMPT: Record<string, string> = {
	"stories/convert-kind.ts":
		"Writes the literal 'DRAFT' (line 191) when flipping kind, so it can " +
		"never land a feature on Ready for Dev.",
	"stories/move-story-roadmap.ts":
		"Mentions draftingStage only in a comment. Neither reads nor writes it.",
	"stories/preview-enrichment.ts":
		"Read-only preview — selects the stage and passes it to the enrichment " +
		"computation, persisting nothing.",
	"stories/reprioritize-stories.ts":
		"Writes priority. Selects the stage only to label features for the " +
		"prioritisation prompt.",
	"stories/reevaluate-bug.ts":
		"Bug-only flow, and it passes the story's existing stage through " +
		"unchanged. Bugs are ineligible for drafting regardless of stage.",
	"stories/tags.ts":
		"Writes tags. Uses the stage once as a WHERE filter ({ not: 'CLOSED' }).",
	"stories/update-with-context.ts":
		"Writes description/context fields and carries the story's existing " +
		"stage through unchanged; it never sets a new one.",
	"bulk-review-pending-state-changes.ts":
		"Only ever writes the literal 'CLOSED' (lines 66, 78) when declining a " +
		"pending change, so it cannot reach Ready for Dev.",
	"slack-channel-monitor/approve-pending-proposal.ts":
		"Creates the story from a proposal at the literal 'PLACEHOLDER' " +
		"(line 765). Never Ready for Dev.",
	"teams-channel-monitor/approve-pending-proposal.ts":
		"Creates the story from a proposal at the literal 'PLACEHOLDER' " +
		"(line 856). Never Ready for Dev.",
};

/** Any of these means the file has taken responsibility for the trigger. */
const TRIGGER_SYMBOLS = [
	"maybeAutoDraftOnStageChange",
	"shouldDraftOnReadyForDev",
	"shouldDraftAfterFeatureReview",
];

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (entry === "__tests__") {
				continue;
			}
			out.push(...walk(full));
			continue;
		}
		if (entry.endsWith(".ts")) {
			out.push(full);
		}
	}
	return out;
}

const files = walk(PROCEDURES_DIR)
	.map((full) => ({
		rel: full.slice(PROCEDURES_DIR.length + 1).replace(/\\/g, "/"),
		source: readFileSync(full, "utf8"),
	}))
	.filter((f) => f.source.includes("draftingStage"));

describe("auto-draft trigger coverage over draftingStage writers", () => {
	it("finds the procedures to check (the scan itself must not silently pass)", () => {
		// A refactor that moves or renames the directory would otherwise turn
		// this whole suite into a green no-op.
		expect(files.length).toBeGreaterThan(8);
	});

	it.each(files.map((f) => f.rel))(
		"%s either runs the trigger or is exempt on purpose",
		(rel) => {
			const file = files.find((f) => f.rel === rel);
			const carriesTrigger = TRIGGER_SYMBOLS.some((s) =>
				file?.source.includes(s),
			);
			const exemptReason = EXEMPT[rel];

			if (carriesTrigger) {
				// Belt and braces: a file cannot be both, or the exempt list is
				// lying about what the code does.
				expect(exemptReason).toBeUndefined();
				return;
			}

			expect(
				exemptReason,
				`${rel} touches draftingStage but neither calls the auto-draft ` +
					"trigger nor appears in EXEMPT. If it can move a feature to " +
					"Ready for Dev, call maybeAutoDraftOnStageChange after the " +
					"write. If it cannot, add it to EXEMPT with the reason.",
			).toBeDefined();
			expect(exemptReason?.length ?? 0).toBeGreaterThan(30);
		},
	);

	it("has no stale exemptions", () => {
		// An exemption for a file that no longer exists hides the next one.
		const present = new Set(files.map((f) => f.rel));
		for (const rel of Object.keys(EXEMPT)) {
			expect(
				present.has(rel),
				`EXEMPT lists ${rel}, which no longer touches draftingStage`,
			).toBe(true);
		}
	});

	it("covers every route a feature can reach Ready for Dev by", () => {
		// Named explicitly so deleting one from the scan is visible in review.
		// `create-story` is here because the input accepts a stage AND acceptance
		// criteria, so a feature can ARRIVE at Ready for Dev without ever
		// transitioning — and then no stage procedure would ever run for it.
		for (const rel of [
			"stories/update-drafting-stage.ts",
			"stories/update-drafting-stage-with-version.ts",
			"stories/update-story.ts",
			"stories/enhance-feature.ts",
			"stories/create-story.ts",
			"stories/versions/restore-feature-version.ts",
		]) {
			const file = files.find((f) => f.rel === rel);
			expect(file, `${rel} vanished from the scan`).toBeDefined();
			expect(
				TRIGGER_SYMBOLS.some((s) => file?.source.includes(s)),
				`${rel} must run the auto-draft trigger`,
			).toBe(true);
		}
	});
});
