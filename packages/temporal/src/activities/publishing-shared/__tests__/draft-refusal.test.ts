import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { draftGenerationFolders, firstCallPosition } from "./_ast-guards";

/**
 * What a refused terminal write says, and how loudly.
 *
 * Four causes used to arrive at fifteen call sites as one bare
 * `{ persisted: false }`, and all fifteen logged the same word: "superseded".
 * That is true of exactly one of them. An operator reading it for the other two goes
 * looking for the newer attempt that supposedly took over, finds none, and ends
 * the investigation more confused than it started — which is a worse outcome
 * than a line that said nothing at all.
 */

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logDraftRefusal } from "@repo/database";
import { logger } from "@repo/logs";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("logDraftRefusal", () => {
	it("keeps a routine supersession at info", () => {
		// The deadline sweep reclaiming a stale attempt is the system working.
		logDraftRefusal(
			"[publishing-blog-post] draft not committed",
			"superseded",
			{
				draftId: "d1",
			},
		);

		expect(logger.info).toHaveBeenCalledTimes(1);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it.each([
		"project_ineligible",
		"tenant_changed",
		"attempt_missing",
	] as const)(
		"raises %s to warn — somebody acted on the project mid-run",
		(reason) => {
			logDraftRefusal(
				"[publishing-blog-post] draft not committed",
				reason,
				{
					draftId: "d1",
				},
			);

			expect(logger.warn).toHaveBeenCalledTimes(1);
			expect(logger.info).not.toHaveBeenCalled();
		},
	);

	it("says something different for each reason, and never says superseded for the others", () => {
		// The failure mode being removed is one sentence for three causes. A
		// table with a shared fallback would satisfy a "was it logged" check
		// while reproducing exactly the defect.
		const said = (
			[
				"superseded",
				"project_ineligible",
				"tenant_changed",
				"attempt_missing",
			] as const
		).map((reason) => {
			vi.clearAllMocks();
			logDraftRefusal("[x] draft not committed", reason, {});
			const call =
				(logger.info as unknown as { mock: { calls: unknown[][] } })
					.mock.calls[0] ??
				(logger.warn as unknown as { mock: { calls: unknown[][] } })
					.mock.calls[0];
			return String(call[0]);
		});

		expect(new Set(said).size).toBe(4);
		expect(said[0]).toMatch(/newer attempt/i);
		expect(said[1]).toMatch(/archived or deleted/i);
		expect(said[1]).not.toMatch(/supersede/i);
		expect(said[2]).toMatch(/different organization/i);
		expect(said[2]).not.toMatch(/supersede/i);
		expect(said[3]).toMatch(/no longer exists/i);
		expect(said[3]).not.toMatch(/supersede/i);
	});

	it("puts the reason in the structured bag, not only in the sentence", () => {
		// A human reads the sentence; a query reads the field. Without it,
		// counting how often a project was archived mid-generation means
		// grepping prose.
		logDraftRefusal("[x] draft not committed", "project_ineligible", {
			draftId: "d1",
			projectId: "p1",
		});

		expect(logger.warn).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				draftId: "d1",
				projectId: "p1",
				reason: "project_ineligible",
			}),
		);
	});
});

describe("every publishing terminal write reports its refusal through the table", () => {
	// The rule is only worth having if ALL of the sites obey it, and only a few
	// are exercised by a suite of their own. A file-by-file structural check is
	// what stops the rest drifting back to a hand-written sentence.
	//
	// Discovered rather than hand-listed, because the hand-written 15-entry
	// list this replaced had already drifted: LinkedIn's three sites (its
	// generate, its mark-failed, its API procedure) were never added, and
	// `expect(SITES).toHaveLength(15)` stayed green throughout because the
	// PIN moved in lockstep with the very list it was meant to guard.
	//
	// `firstCallPosition` and not a source-text search: the comment above each
	// call describes the reasons in prose, so a grep for "superseded" would
	// report the comment, and a grep for the helper name would stay green after
	// the call itself was deleted.
	const PACKAGES = join(__dirname, "..", "..", "..", "..", "..");
	const ACTIVITIES_DIR = join(__dirname, "..", "..");
	const API_PUBLISHING_SUITE_DIR = join(
		PACKAGES,
		"api/modules/projects/procedures/publishing-suite",
	);

	/**
	 * `path.relative` returns backslash-separated paths on Windows; every
	 * literal comparison below (and the pre-existing `SITES` array this
	 * replaced) is written POSIX-style, so this is where that gets reconciled
	 * rather than at every call site.
	 */
	function toPosixRelative(from: string, to: string): string {
		return relative(from, to).split(sep).join("/");
	}

	/**
	 * The five `@repo/database` entry points that commit or refuse a draft or
	 * planning-analysis terminal write. NOT discovered — these are the fixed
	 * vocabulary the table exists to cover, same as `logDraftRefusal`'s own
	 * reason union. What IS discovered is every FILE that calls one of them,
	 * which is the part that used to drift.
	 */
	const TERMINAL_WRITE_HELPERS = [
		"completeTopicDraft",
		"failTopicDraft",
		"completePlanningAnalysis",
		"failPlanningAnalysis",
		"startTopicDraftAttempt",
	];

	function tsFilesDirectlyIn(dir: string): string[] {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
			.map((entry) => join(dir, entry.name));
	}

	// `draftGenerationFolders()` — the "publishing-* folder with both a
	// generate-*.ts and a mark-*-failed.ts file" rule — lives in `_ast-guards.ts`
	// now, shared with `publishing-failure-message.test.ts`. Both needed exactly
	// this rule; keeping two copies is the drift risk this task exists to remove.

	/** The `generate-*.ts` and `mark-*-failed.ts` files those folders contain. */
	function expectedDraftActivityFiles(): string[] {
		const out: string[] = [];
		for (const folder of draftGenerationFolders()) {
			const dir = join(ACTIVITIES_DIR, folder);
			for (const file of readdirSync(dir)) {
				if (
					/^generate-.*\.ts$/.test(file) ||
					/^mark-.*-failed\.ts$/.test(file)
				) {
					out.push(toPosixRelative(PACKAGES, join(dir, file)));
				}
			}
		}
		return out.sort();
	}

	/**
	 * Every file, across the Temporal activities AND the API procedures, that
	 * calls at least one terminal-write helper — the discovered replacement
	 * for the old hand-written `SITES` array.
	 */
	function discoverTerminalWriteSites(): string[] {
		const candidates = [
			...draftGenerationFolders().flatMap((folder) =>
				tsFilesDirectlyIn(join(ACTIVITIES_DIR, folder)),
			),
			...tsFilesDirectlyIn(API_PUBLISHING_SUITE_DIR),
		];
		return candidates
			.filter((file) =>
				TERMINAL_WRITE_HELPERS.some(
					(helper) => firstCallPosition(file, helper) > -1,
				),
			)
			.map((file) => toPosixRelative(PACKAGES, file))
			.sort();
	}

	describe("discovery preconditions — the guard cannot pass vacuously (draft refusal)", () => {
		it("finds the draft-generation folders it is supposed to find", () => {
			const folders = draftGenerationFolders();
			expect(folders).toContain("publishing-case-study");
			expect(folders).toContain("publishing-linkedin-post");
			expect(folders).toContain("publishing-webinar-script");
			expect(folders).not.toContain("publishing-shared");
			expect(folders).not.toContain("publishing-suggestion");
			expect(folders.length).toBeGreaterThanOrEqual(8);
		});

		it("finds a plausible set of expected generate/mark files", () => {
			const files = expectedDraftActivityFiles();
			expect(files).toContain(
				"temporal/src/activities/publishing-case-study/generate-case-study.ts",
			);
			expect(files).toContain(
				"temporal/src/activities/publishing-webinar-script/mark-webinar-script-failed.ts",
			);
			// Eight folders, two files each.
			expect(files.length).toBeGreaterThanOrEqual(16);
		});
	});

	const SITES = discoverTerminalWriteSites();

	it("discovers a plausible, non-empty set of terminal-write call sites", () => {
		// Named explicitly rather than resting on the floor alone: LinkedIn's
		// omission and the webinar-script slice's addition are exactly the two
		// things this rebuild must not let slip through silently again.
		expect(SITES).toContain(
			"temporal/src/activities/publishing-linkedin-post/generate-linkedin-post.ts",
		);
		expect(SITES).toContain(
			"temporal/src/activities/publishing-linkedin-post/mark-linkedin-post-failed.ts",
		);
		expect(SITES).toContain(
			"api/modules/projects/procedures/publishing-suite/linkedin-post.ts",
		);
		expect(SITES).toContain(
			"temporal/src/activities/publishing-webinar-script/generate-webinar-script.ts",
		);
		expect(SITES).toContain(
			"temporal/src/activities/publishing-webinar-script/mark-webinar-script-failed.ts",
		);
		expect(SITES).toContain(
			"api/modules/projects/procedures/publishing-suite/webinar-script.ts",
		);
		expect(SITES).toContain(
			"temporal/src/activities/publishing-newsletter-blurb/generate-newsletter-blurb.ts",
		);
		expect(SITES).toContain(
			"temporal/src/activities/publishing-newsletter-blurb/mark-newsletter-blurb-failed.ts",
		);
		expect(SITES).toContain(
			"api/modules/projects/procedures/publishing-suite/newsletter-blurb.ts",
		);
		// 7 draft content types plus the planning analysis — 8 generation
		// folders × (generate + mark) — and the 8 API procedures that open or
		// close those attempts. Raised from 21 to the run's TRUE count when the
		// Newsletter Blurb slice landed, deliberately rather than because the
		// old floor went red: a floor that stays below the real number can
		// tolerate losing exactly the sites a slice just added. The three names
		// above are what make this a check on IDENTITY rather than on count.
		expect(SITES.length).toBeGreaterThanOrEqual(24);
	});

	it("covers every generate-*.ts / mark-*-failed.ts pair discovery expects to find", () => {
		// Guards the helper list itself: a future content type that calls some
		// OTHER terminal-write helper would be invisible to
		// `discoverTerminalWriteSites`, but it would still show up here,
		// because this check is purely structural (folder + filename) and does
		// not go through `TERMINAL_WRITE_HELPERS` at all.
		const missing = expectedDraftActivityFiles().filter(
			(file) => !SITES.includes(file),
		);
		expect(missing).toEqual([]);
	});

	for (const file of SITES) {
		it(`${file} calls logDraftRefusal`, () => {
			expect(
				firstCallPosition(join(PACKAGES, file), "logDraftRefusal"),
			).toBeGreaterThan(-1);
		});
	}
});
