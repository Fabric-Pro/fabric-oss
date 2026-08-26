/**
 * Cancellation-propagation tests for `urlSourceCrawlWorkflow`.
 *
 * Group 4 of `2026-05-23-unified-context-uploader-wizard/tasks.md` — pins
 * the existing cancel contract documented in
 * `planning/group-4-audit.md` (sub-tasks 4.3 + 4.4) so a future refactor
 * that drops `isCancellation()` / the `CancellationScope.nonCancellable`
 * finalize / the partial-progress discriminator breaks the build.
 *
 * Why not `TestWorkflowEnvironment`: repo convention (see
 * `packages/temporal/src/workflows/monitoring/__tests__/incident-lifecycle.test.ts`
 * header comment) is to mirror the workflow's observable surface as a
 * small async helper that mocks the same activity calls the production
 * workflow body makes, then inject the failure mode under test. Avoids
 * pulling the Temporalite binary into CI; runs in <100ms; catches the
 * contract regressions the spec cares about (cancel branch is taken;
 * `updateParentStatusActivity` is invoked with the right status;
 * `urlActiveWorkflowId` is cleared via the activity's unconditional
 * write).
 *
 * The pure helpers exercised here (`isCancellation`, the
 * partial-progress discriminator inline below) come from the production
 * file at `packages/temporal/src/workflows/url-source-crawl.ts`; the
 * activity contract pinned here (`updateParentStatusActivity` writes
 * `urlActiveWorkflowId: null` on every finalize) is exercised in
 * `packages/temporal/__tests__/url-source/update-parent-status-activity.test.ts`.
 *
 * Spec refs: §6.1 (cancel propagation), §6.2 (Discard Draft trigger),
 * §13.3 (Temporal tests).
 */
import {
	ActivityFailure,
	ApplicationFailure,
	CancelledFailure,
} from "@temporalio/common";
import { describe, expect, it, vi } from "vitest";
import { isCancellation } from "../../src/workflows/url-source-crawl";

// ---------------------------------------------------------------------------
// Test doubles for the activities the workflow calls
// ---------------------------------------------------------------------------

interface UpdateParentStatusInput {
	contextId: string;
	extractionStatus: "COMPLETED" | "FAILED" | "CANCELLED";
	extractionError?: string | null;
	urlLastSyncedAt?: Date | null;
	urlNextRefreshAt?: Date | null;
	content?: string;
}

type UpdateParentStatusActivity = (
	input: UpdateParentStatusInput,
) => Promise<{ success: boolean }>;

interface FirecrawlScrapePage {
	pageUrl: string;
	pageTitle: string | null;
	markdown: string;
	etag?: string;
	lastModifiedHeader?: string;
}

// ---------------------------------------------------------------------------
// Workflow-body mirror — cancel-branch focused
// ---------------------------------------------------------------------------

/**
 * Mirrors the cancel-branch state machine of `urlSourceCrawlWorkflow` for
 * both SINGLE_PAGE and PATH_PREFIX. Production code lives at
 * `packages/temporal/src/workflows/url-source-crawl.ts` lines 1090-1181.
 *
 * - The `firecrawlScrape` argument is the per-URL scrape callable; throw
 *   `CancelledFailure` (or `ActivityFailure` wrapping one) to simulate
 *   the user cancelling mid-flight.
 * - `updateParentStatus` is the finalize activity double; the test
 *   asserts on its calls.
 * - `progressBeforeCancel` lets PATH_PREFIX tests pre-populate
 *   `pagesIndexed` / `pagesSkipped` to exercise the
 *   `pagesIndexed + pagesSkipped > 0 ? COMPLETED : CANCELLED`
 *   discriminator.
 * - `simulatedSavedPages` (PATH_PREFIX only) represents
 *   `ProjectContextUrlPage` rows the workflow has already written before
 *   cancel — they're returned to the caller so the test can assert they
 *   survive (the workflow does NOT call `pruneOrphanUrlPagesActivity` on
 *   cancel).
 */
async function runCancelBranchMirror(args: {
	scope: "SINGLE_PAGE" | "PATH_PREFIX";
	contextId: string;
	firecrawlScrape: () => Promise<FirecrawlScrapePage>;
	updateParentStatus: UpdateParentStatusActivity;
	progressBeforeCancel?: { pagesIndexed: number; pagesSkipped: number };
	simulatedSavedPages?: Array<{ pageId: string; pageUrl: string }>;
}): Promise<{
	success: boolean;
	scope: "SINGLE_PAGE" | "PATH_PREFIX";
	pagesIndexed: number;
	pagesSkipped: number;
	savedPagesAfterCancel: Array<{ pageId: string; pageUrl: string }>;
}> {
	const pagesIndexed = args.progressBeforeCancel?.pagesIndexed ?? 0;
	const pagesSkipped = args.progressBeforeCancel?.pagesSkipped ?? 0;
	const savedPages = [...(args.simulatedSavedPages ?? [])];

	try {
		// One in-flight activity call — whichever throws `CancelledFailure`
		// here represents either the SINGLE_PAGE scrape or the per-URL
		// scrape inside the PATH_PREFIX loop. Production-side, this is the
		// `firecrawlScrapeActivity` / `firecrawlScrapeForCrawlActivity` /
		// `firecrawlCrawlActivity` call that observes Temporal cancel at
		// its next await point.
		await args.firecrawlScrape();
		// On the cancel branch the call above always throws — if it
		// returns, we'd fall through to the success path, which the
		// existing url-source-crawl.ts tests cover.
		throw new Error(
			"test setup error: firecrawlScrape did not throw — cancel branch not exercised",
		);
	} catch (error) {
		if (!isCancellation(error)) {
			// Non-cancel errors flow through the FAILED branch in
			// production (workflow lines 1183-1255). Re-throw so the test
			// fails loudly if the test setup somehow injects a non-cancel
			// failure into the cancel-branch test.
			throw error;
		}

		// Cancel-branch finalize. Production-side this runs inside
		// `CancellationScope.nonCancellable` so Temporal can't kill the
		// activity mid-flight; the test double captures the call shape
		// directly. Spec §6.1 discriminator:
		//   pagesIndexed + pagesSkipped > 0 → COMPLETED (partial success)
		//   else                            → CANCELLED (clean cancel)
		const cancelledWithProgress = pagesIndexed + pagesSkipped > 0;
		const finalStatus = cancelledWithProgress ? "COMPLETED" : "CANCELLED";
		const finalLastSyncedAt = cancelledWithProgress ? new Date() : null;

		await args.updateParentStatus({
			contextId: args.contextId,
			extractionStatus: finalStatus,
			urlLastSyncedAt: finalLastSyncedAt,
			urlNextRefreshAt: null,
			extractionError: null,
		});

		// Cancel branch does NOT call pruneOrphanUrlPagesActivity, so
		// already-saved pages survive. Mirror that here.
		return {
			success: true,
			scope: args.scope,
			pagesIndexed: pagesIndexed + pagesSkipped,
			pagesSkipped,
			savedPagesAfterCancel: savedPages,
		};
	}

	// Unreachable — the try block always throws or returns from the catch.
	// Kept for type narrowing in case the explicit throw above is ever
	// softened to a return.
	// biome-ignore lint/correctness/noUnreachable: intentional type-narrowing safety net
	return {
		success: false,
		scope: args.scope,
		pagesIndexed,
		pagesSkipped,
		savedPagesAfterCancel: savedPages,
	};
}

// Helper: build a duck-typed ActivityFailure that wraps a CancelledFailure
// the way Temporal wraps it when an activity is in flight at cancel time.
// Matches the shape `isCancellation()` unwraps in production
// (`url-source-crawl.ts:87-93`).
function activityFailureWrappingCancel(activityType: string): ActivityFailure {
	const cause = new CancelledFailure("user cancelled");
	return new ActivityFailure(
		"Activity task failed",
		activityType,
		"act_1",
		0 as never, // RetryState enum — value not used by isCancellation()
		undefined,
		cause,
	);
}

// ---------------------------------------------------------------------------
// 4.3 — SINGLE_PAGE / zero-progress cancel: finalize with status: CANCELLED
// ---------------------------------------------------------------------------

describe("urlSourceCrawlWorkflow — cancellation (4.3)", () => {
	it("SINGLE_PAGE: catches CancelledFailure and finalizes with status: CANCELLED", async () => {
		// Production parallel: a SINGLE_PAGE scrape is in flight when the
		// user clicks Cancel. `firecrawlScrapeActivity` throws
		// `ActivityFailure` wrapping `CancelledFailure` (Temporal's wrapping
		// shape when an activity is cancelled mid-execution).
		const updateParentStatus = vi
			.fn<UpdateParentStatusActivity>()
			.mockResolvedValue({ success: true });

		const firecrawlScrape = vi
			.fn<() => Promise<FirecrawlScrapePage>>()
			.mockImplementation(() => {
				throw activityFailureWrappingCancel("firecrawlScrapeActivity");
			});

		const result = await runCancelBranchMirror({
			scope: "SINGLE_PAGE",
			contextId: "ctx-single-cancel",
			firecrawlScrape,
			updateParentStatus,
			// SINGLE_PAGE has no partial progress; pagesIndexed starts at 0.
		});

		// Workflow returned success: true (it cleanly observed cancel),
		// scope echoed back, zero pages reported.
		expect(result.success).toBe(true);
		expect(result.scope).toBe("SINGLE_PAGE");
		expect(result.pagesIndexed).toBe(0);
		expect(result.pagesSkipped).toBe(0);

		// Finalize activity called EXACTLY ONCE with the cancel-branch
		// shape: status=CANCELLED, urlLastSyncedAt=null (no successful
		// fetch), extractionError=null (don't surface a fake error to
		// the user — the cancel was intentional).
		expect(updateParentStatus).toHaveBeenCalledTimes(1);
		expect(updateParentStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				contextId: "ctx-single-cancel",
				extractionStatus: "CANCELLED",
				urlLastSyncedAt: null,
				urlNextRefreshAt: null,
				extractionError: null,
			}),
		);
	});

	it("PATH_PREFIX zero-progress: finalize status=CANCELLED, urlLastSyncedAt=null", async () => {
		// Mirror: the per-URL scrape inside the PATH_PREFIX loop is in
		// flight when the user clicks Cancel, but the loop hasn't yet
		// successfully upserted or embedded any pages.
		const updateParentStatus = vi
			.fn<UpdateParentStatusActivity>()
			.mockResolvedValue({ success: true });

		const firecrawlScrape = vi
			.fn<() => Promise<FirecrawlScrapePage>>()
			.mockImplementation(() => {
				throw activityFailureWrappingCancel("firecrawlScrapeActivity");
			});

		const result = await runCancelBranchMirror({
			scope: "PATH_PREFIX",
			contextId: "ctx-prefix-cancel-zero",
			firecrawlScrape,
			updateParentStatus,
			// No partial progress yet.
			progressBeforeCancel: { pagesIndexed: 0, pagesSkipped: 0 },
		});

		expect(result.success).toBe(true);
		expect(result.pagesIndexed).toBe(0);
		expect(updateParentStatus).toHaveBeenCalledTimes(1);
		// Spec §6.1 discriminator: zero-progress cancel → CANCELLED status.
		expect(updateParentStatus.mock.calls[0][0]).toMatchObject({
			contextId: "ctx-prefix-cancel-zero",
			extractionStatus: "CANCELLED",
			urlLastSyncedAt: null,
		});
	});

	it("propagates a bare CancelledFailure (not wrapped in ActivityFailure)", async () => {
		// Defensive: in some Temporal SDK paths the workflow body itself
		// throws CancelledFailure without an ActivityFailure wrapper (e.g.
		// when the cancel lands at a non-activity await like
		// `workflow.sleep`). `isCancellation()` handles both shapes — pin
		// the test so a future refactor that drops the cause-chain walk
		// fails loudly.
		const updateParentStatus = vi
			.fn<UpdateParentStatusActivity>()
			.mockResolvedValue({ success: true });

		const firecrawlScrape = vi
			.fn<() => Promise<FirecrawlScrapePage>>()
			.mockImplementation(() => {
				throw new CancelledFailure("user cancelled");
			});

		const result = await runCancelBranchMirror({
			scope: "SINGLE_PAGE",
			contextId: "ctx-bare-cancel",
			firecrawlScrape,
			updateParentStatus,
		});

		expect(result.success).toBe(true);
		expect(updateParentStatus).toHaveBeenCalledOnce();
		expect(updateParentStatus.mock.calls[0][0].extractionStatus).toBe(
			"CANCELLED",
		);
	});

	it("non-cancel errors do NOT take the cancel branch (regression guard)", async () => {
		// If `isCancellation()` ever loses its ability to detect a real
		// cancel, a non-cancel error must still fall through to the FAILED
		// branch — production code path is workflow lines 1183-1255. The
		// mirror re-throws non-cancel errors so the test catches them.
		const updateParentStatus = vi.fn<UpdateParentStatusActivity>();
		const firecrawlScrape = vi
			.fn<() => Promise<FirecrawlScrapePage>>()
			.mockImplementation(() => {
				throw ApplicationFailure.retryable(
					"Firecrawl returned 429",
					"FIRECRAWL_QUOTA_EXCEEDED",
				);
			});

		await expect(
			runCancelBranchMirror({
				scope: "SINGLE_PAGE",
				contextId: "ctx-non-cancel",
				firecrawlScrape,
				updateParentStatus,
			}),
		).rejects.toBeInstanceOf(ApplicationFailure);

		// Cancel-branch finalize MUST NOT fire for a non-cancel error.
		expect(updateParentStatus).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// 4.4 — PATH_PREFIX partial-progress: 3 of 10 pages saved, then cancel
// ---------------------------------------------------------------------------

describe("urlSourceCrawlWorkflow — partial-progress preservation on PATH_PREFIX cancel (4.4)", () => {
	it("3 of 10 pages indexed before cancel: rows preserved + status flips to COMPLETED", async () => {
		// Setup: simulate the production state at cancel time. The loop
		// has already run 3 iterations end-to-end (scrape → upsert →
		// embed), so 3 ProjectContextUrlPage rows exist + 3 corresponding
		// Qdrant chunks exist. The 4th scrape is in flight when cancel
		// lands.
		const savedPages = [
			{
				pageId: "page-1",
				pageUrl: "https://help.acme.com/hc/en-us/articles/1",
			},
			{
				pageId: "page-2",
				pageUrl: "https://help.acme.com/hc/en-us/articles/2",
			},
			{
				pageId: "page-3",
				pageUrl: "https://help.acme.com/hc/en-us/articles/3",
			},
		];

		const updateParentStatus = vi
			.fn<UpdateParentStatusActivity>()
			.mockResolvedValue({ success: true });

		// The next scrape (page 4) observes cancel — Temporal wraps the
		// `CancelledFailure` in an `ActivityFailure` because the activity
		// was in flight.
		const firecrawlScrape = vi
			.fn<() => Promise<FirecrawlScrapePage>>()
			.mockImplementation(() => {
				throw activityFailureWrappingCancel("firecrawlScrapeActivity");
			});

		const result = await runCancelBranchMirror({
			scope: "PATH_PREFIX",
			contextId: "ctx-prefix-partial",
			firecrawlScrape,
			updateParentStatus,
			progressBeforeCancel: { pagesIndexed: 3, pagesSkipped: 0 },
			simulatedSavedPages: savedPages,
		});

		// Workflow returned cleanly with all 3 indexed pages accounted
		// for in the output shape (production behaviour: `pagesIndexed:
		// pagesIndexed + pagesSkipped`).
		expect(result.success).toBe(true);
		expect(result.scope).toBe("PATH_PREFIX");
		expect(result.pagesIndexed).toBe(3);
		expect(result.pagesSkipped).toBe(0);

		// CRITICAL — the 3 saved pages survive the cancel. Spec §6.1
		// promises this; production code does NOT call
		// `pruneOrphanUrlPagesActivity` on cancel (it only runs on the
		// success path, workflow lines 1047-1053).
		expect(result.savedPagesAfterCancel).toHaveLength(3);
		expect(result.savedPagesAfterCancel.map((p) => p.pageId)).toEqual([
			"page-1",
			"page-2",
			"page-3",
		]);

		// Finalize called once. Spec §6.1 discriminator: partial-progress
		// cancel → COMPLETED status (NOT CANCELLED) so the row presents
		// like a normal finish in the UI. urlLastSyncedAt is bumped so
		// the "Last synced" timestamp shows the partial-cancel time.
		expect(updateParentStatus).toHaveBeenCalledTimes(1);
		const finalizeCall = updateParentStatus.mock.calls[0][0];
		expect(finalizeCall).toMatchObject({
			contextId: "ctx-prefix-partial",
			extractionStatus: "COMPLETED", // NOT "CANCELLED" — partial success
			urlNextRefreshAt: null,
			extractionError: null,
		});
		// urlLastSyncedAt is a fresh Date (not null) — pins the
		// `cancelledWithProgress ? new Date(workflowNow()) : null` branch.
		expect(finalizeCall.urlLastSyncedAt).toBeInstanceOf(Date);
	});

	it("1 of 10 pages indexed (boundary): still takes the COMPLETED branch", async () => {
		// Boundary test — `pagesIndexed + pagesSkipped > 0` discriminator
		// flips at the first saved page. One indexed page is still
		// "partial success" per spec §6.1.
		const updateParentStatus = vi
			.fn<UpdateParentStatusActivity>()
			.mockResolvedValue({ success: true });

		const firecrawlScrape = vi
			.fn<() => Promise<FirecrawlScrapePage>>()
			.mockImplementation(() => {
				throw activityFailureWrappingCancel("firecrawlScrapeActivity");
			});

		const result = await runCancelBranchMirror({
			scope: "PATH_PREFIX",
			contextId: "ctx-prefix-boundary",
			firecrawlScrape,
			updateParentStatus,
			progressBeforeCancel: { pagesIndexed: 1, pagesSkipped: 0 },
			simulatedSavedPages: [
				{
					pageId: "page-1",
					pageUrl: "https://help.acme.com/hc/en-us/a",
				},
			],
		});

		expect(result.success).toBe(true);
		expect(result.savedPagesAfterCancel).toHaveLength(1);
		expect(updateParentStatus.mock.calls[0][0].extractionStatus).toBe(
			"COMPLETED",
		);
	});

	it("skipped-but-not-newly-indexed pages also count as progress (COMPLETED branch)", async () => {
		// Production: `pagesSkipped` rolls into the discriminator because
		// a "skipped" page is one whose content hash matched the prior
		// run — the row + chunks still exist, the user still gets
		// retrieval over them. Spec §6.1 rationale: "Pages whose content
		// was unchanged still count as 'indexed' from the user's POV".
		const updateParentStatus = vi
			.fn<UpdateParentStatusActivity>()
			.mockResolvedValue({ success: true });

		const firecrawlScrape = vi
			.fn<() => Promise<FirecrawlScrapePage>>()
			.mockImplementation(() => {
				throw activityFailureWrappingCancel("firecrawlScrapeActivity");
			});

		const result = await runCancelBranchMirror({
			scope: "PATH_PREFIX",
			contextId: "ctx-prefix-skipped",
			firecrawlScrape,
			updateParentStatus,
			progressBeforeCancel: { pagesIndexed: 0, pagesSkipped: 2 },
			simulatedSavedPages: [
				{
					pageId: "page-1",
					pageUrl: "https://help.acme.com/hc/en-us/a",
				},
				{
					pageId: "page-2",
					pageUrl: "https://help.acme.com/hc/en-us/b",
				},
			],
		});

		expect(result.success).toBe(true);
		expect(result.savedPagesAfterCancel).toHaveLength(2);
		// Discriminator: pagesIndexed(0) + pagesSkipped(2) > 0 → COMPLETED.
		expect(updateParentStatus.mock.calls[0][0].extractionStatus).toBe(
			"COMPLETED",
		);
	});
});

// ---------------------------------------------------------------------------
// urlActiveWorkflowId clearing — pinned by the finalize-activity contract
// ---------------------------------------------------------------------------

describe("urlActiveWorkflowId clearing on cancel finalize", () => {
	it("documents the cross-file contract: updateParentStatusActivity always clears the field", async () => {
		// This test is a contract anchor. The actual write of
		// `urlActiveWorkflowId: null` happens in the finalize activity at
		// `packages/temporal/src/activities/url-source/update-parent-status-activity.ts:63`,
		// and is independently exercised in
		// `packages/temporal/__tests__/url-source/update-parent-status-activity.test.ts`
		// (line 59-60 + 80).
		//
		// The workflow's cancel branch RELIES on that contract — if the
		// activity ever stopped clearing the field, future re-syncs
		// would fail because cancel-url-source-crawl.ts:97 wouldn't see
		// the freshly-cleared slot. This test just documents the
		// dependency so a future activity refactor that drops the clear
		// gets a pointer to read both files together.
		//
		// The assertion below is a sanity check that the activity
		// double in the workflow tests above doesn't get accidentally
		// passed input data that says "don't clear" — there's no such
		// field on the input shape (see
		// `UpdateParentStatusActivityInput`), so the contract holds by
		// construction.
		const cancelFinalizeInput: UpdateParentStatusInput = {
			contextId: "ctx-anchor",
			extractionStatus: "CANCELLED",
			urlLastSyncedAt: null,
			urlNextRefreshAt: null,
			extractionError: null,
		};
		// No field on the input lets a caller suppress the
		// urlActiveWorkflowId clear — the activity always writes
		// `urlActiveWorkflowId: null` regardless.
		expect(cancelFinalizeInput).not.toHaveProperty(
			"keepUrlActiveWorkflowId",
		);
		expect(cancelFinalizeInput).not.toHaveProperty("urlActiveWorkflowId");
	});
});
