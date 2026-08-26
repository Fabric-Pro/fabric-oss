/**
 * Lock tests for three guarantees that hold today only because nobody wrote the
 * code that would break them.
 *
 * Before this feature, "attachment content never leaves Fabric" was structural:
 * no extraction existed, so there was nothing to leak. That is no longer true —
 * attachment text is now extracted, cached on the row, and delivered to a model.
 * The guarantees below survived the change, but they survived by construction
 * rather than by assertion, and construction is exactly what a future PR edits.
 *
 * These are drift guards, not feature tests. Each one should fail loudly the
 * day someone adds attachments to a sync payload, widens a list `select`, or
 * filters the count badge. If one starts failing, the question to ask is
 * whether the behaviour change was intended and disclosed — not how to make the
 * test pass.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "../../../../../../../..");

function read(relativePath: string): string {
	return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

describe("extracted attachment text stays out of non-agent reads (R14)", () => {
	const listAttachments = read(
		"packages/api/modules/projects/procedures/stories/attachments/list-attachments.ts",
	);

	it("the list procedure does not select the extracted text column", () => {
		// Matched as a select key rather than as any mention of the word: the
		// file names the column in a comment explaining why it is excluded, and
		// that comment is worth keeping.
		expect(listAttachments).not.toMatch(/extractedText\s*:\s*true/);
	});

	it("the list procedure still uses an explicit select", () => {
		// The guard above is only meaningful while the query enumerates its
		// columns. If this assertion fails, R14 has silently lost its mechanism
		// even though the check above may still pass.
		expect(listAttachments).toMatch(/select:\s*\{/);
	});

	it("the list response is a closed projection, not a row spread", () => {
		// The deeper guard. A spread makes the payload an open set — every
		// column added to the model ships to the browser by default. The
		// procedure used to spread the row minus storageKey, which meant the
		// select was the only thing standing between document text and the
		// client. Naming the response fields is what makes that a second layer.
		expect(listAttachments).not.toMatch(/\.\.\.rest/);
		expect(listAttachments).toMatch(/downloadUrl,\s*\}/);
	});

	it("only the resolver reads the extracted text column", () => {
		// One reader is the invariant recorded on the model in schema.prisma.
		//
		// This asserts EXCLUSIVITY, which is the whole point — an earlier
		// version of this test asserted that the resolver contains
		// "extractedText", which is true by construction and would have passed
		// no matter how many other files started reading the column.
		// Two conditions, both required, because either alone is wrong:
		//
		//  - SHAPE OF A READ (a Prisma `select` entry or a property access), not
		//    any mention — several files name the column in prose explaining why
		//    they must NOT select it, and a bare grep flags the very comments
		//    that document the rule.
		//  - TOUCHES StoryAttachment — a different model carries a column by the
		//    same name, and its readers are unrelated to this guarantee.
		const READ_SHAPE = "extractedText:[[:space:]]*true|\\.extractedText";

		const ALLOWED = new Set([
			"packages/api/modules/projects/lib/story-attachment-ai-context.ts",
		]);

		const grep = (args: string[]): string[] =>
			execFileSync("git", ["grep", ...args, "--", "packages", "apps"], {
				cwd: REPO_ROOT,
				encoding: "utf8",
			})
				.split("\n")
				.filter(Boolean);

		const touchesModel = new Set(grep(["-il", "storyAttachment"]));
		const hits = grep(["-lE", READ_SHAPE])
			.filter((p) => touchesModel.has(p))
			// Tests assert on the column; they cannot expose it.
			.filter((p) => !p.includes("__tests__"))
			.filter((p) => !ALLOWED.has(p));

		expect(hits).toEqual([]);
	});
});

describe("attachments stay out of ticket exports (R16)", () => {
	// FR7's counterpart to the PM-sync guard below. Exports are the other
	// deliverable-facing surface, and like sync they satisfy the requirement by
	// containing no attachment code at all — which is exactly the kind of
	// guarantee that evaporates the day someone adds "include attachments" to
	// the export builder without knowing it was ever a rule.
	const exportBuilder = read(
		"packages/api/modules/projects/procedures/stories/create-stories-batch-download-url.ts",
	);

	it("the batch export builder never reads attachment rows", () => {
		expect(exportBuilder).not.toContain("storyAttachment");
		expect(exportBuilder).not.toContain("extractedText");
	});

	it("its only use of the word attachment is the HTTP disposition header", () => {
		// Guards against a false pass if the assertion above is ever softened:
		// `attachment; filename=` is Content-Disposition syntax, unrelated to
		// StoryAttachment rows.
		const uses = exportBuilder.match(/attachment/gi) ?? [];
		expect(uses).toHaveLength(1);
		expect(exportBuilder).toContain("attachment; filename=");
	});
});

describe("attachments stay out of outbound PM sync (R15)", () => {
	const storySync = read(
		"packages/temporal/src/activities/pm-integration/story-sync.ts",
	);

	it("touches attachments only to reclaim storage keys after a delete", () => {
		// The single storyAttachment read in the sync path exists to clean up
		// orphaned objects after the FK cascade removes rows. It selects
		// storageKey and nothing else. A second usage, or a widened select,
		// means attachment data reached an outbound payload.
		const usages = storySync.match(/db\.storyAttachment\./g) ?? [];
		expect(usages).toHaveLength(1);
		expect(storySync).toContain("select: { storageKey: true }");
	});

	it("never puts attachment text or filenames in a sync payload", () => {
		expect(storySync).not.toContain("extractedText");
		expect(storySync).not.toMatch(/attachments?\.map\([^)]*filename/);
	});
});

describe("the count badge counts every live attachment (R17)", () => {
	const badge = read(
		"apps/web/modules/saas/projects/components/stories/StoryAttachmentsButton.tsx",
	);

	it("counts the full list without filtering on designation", () => {
		// The badge signals "this ticket has attachments", not "this ticket has
		// deliverables". Whether that stays true is a product question with an
		// open owner; until it is answered the count must not quietly diverge.
		expect(badge).toContain("attachments.length");
		expect(badge).not.toContain("UNLOCKED");
		expect(badge).not.toContain("LOCKED");
	});
});
