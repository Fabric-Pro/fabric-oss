/**
 * Unit tests for `scanAndDispatchContextSummariesActivity` — the auto-trigger
 * cron handler.
 *
 * The activity runs one cheap grouped pre-filter (`getContextVolumeCandidates`,
 * already HAVING SUM(chars) >= minChars) and then refines each candidate
 * against its latest COMPLETED summary before dispatching. These tests pin the
 * qualification matrix (no-summary threshold, watermark, uncovered-volume, and
 * staleness branches), the resilience of the per-candidate try/catch, and the
 * env-override wiring for the token / staleness knobs.
 *
 * Harness mirrors the other activity tests in this package (e.g.
 * `apply-backlog-changes-pm-auto-sync.test.ts`): hoisted `vi.fn()` stubs, the
 * real `estimateTokensFromChars` formula re-exported from the `@repo/database`
 * mock, and `@temporalio/activity`'s `heartbeat` stubbed to a no-op so the
 * activity can run outside a real Temporal activity context.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks, ENGINE_VERSION } = vi.hoisted(() => ({
	mocks: {
		getContextVolumeCandidates: vi.fn(),
		getLatestCompletedContextSummary: vi.fn(),
		countRawContextChars: vi.fn(),
		isContextSummarizationEnabled: vi.fn(),
		startContextSummarizationWorkflow: vi.fn(),
		heartbeat: vi.fn(),
	},
	// Current engine version — mock summaries stamp this so they read as
	// trustworthy (v2); the legacy-rebuild test uses a lower value.
	ENGINE_VERSION: 2,
}));

vi.mock("@repo/database", () => ({
	getContextVolumeCandidates: mocks.getContextVolumeCandidates,
	getLatestCompletedContextSummary: mocks.getLatestCompletedContextSummary,
	countRawContextChars: mocks.countRawContextChars,
	CONTEXT_SUMMARY_ENGINE_VERSION: ENGINE_VERSION,
	// The activity depends on the real heuristic (~4 chars/token) to translate
	// the token threshold into a char threshold; re-export it verbatim.
	estimateTokensFromChars: (chars: number) => Math.ceil(chars / 4),
}));

vi.mock("@repo/utils/feature-flag", () => ({
	isContextSummarizationEnabled: mocks.isContextSummarizationEnabled,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@temporalio/activity", () => ({ heartbeat: mocks.heartbeat }));

vi.mock("../../../lib/start-context-summarization", () => ({
	startContextSummarizationWorkflow: mocks.startContextSummarizationWorkflow,
}));

import type { ContextVolumeCandidate } from "@repo/database";
import { scanAndDispatchContextSummariesActivity } from "../scan-and-dispatch";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): Date => new Date(Date.now() - n * MS_PER_DAY);

function makeCandidate(
	overrides: Partial<ContextVolumeCandidate> = {},
): ContextVolumeCandidate {
	return {
		projectId: "proj-1",
		userId: "user-1",
		organizationId: null,
		// At the default threshold (50k tokens) the pre-filter's minChars is
		// 200k; a candidate at exactly that clears estimateTokens >= threshold.
		rawChars: 200_000,
		contextCount: 12,
		latestContextAt: daysAgo(1),
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.isContextSummarizationEnabled.mockReturnValue(true);
	mocks.getContextVolumeCandidates.mockResolvedValue([]);
	mocks.getLatestCompletedContextSummary.mockResolvedValue(null);
	mocks.countRawContextChars.mockResolvedValue(0);
	mocks.startContextSummarizationWorkflow.mockResolvedValue({
		workflowId: "context-summarization-proj-1",
		started: true,
	});
	process.env.CONTEXT_SUMMARIZATION_TOKEN_THRESHOLD = undefined;
	process.env.CONTEXT_SUMMARIZATION_STALE_DAYS = undefined;
	delete process.env.CONTEXT_SUMMARIZATION_TOKEN_THRESHOLD;
	delete process.env.CONTEXT_SUMMARIZATION_STALE_DAYS;
});

describe("scanAndDispatchContextSummariesActivity — feature gate", () => {
	it("no-ops when the feature is disabled (no query, no dispatch)", async () => {
		mocks.isContextSummarizationEnabled.mockReturnValue(false);

		const result = await scanAndDispatchContextSummariesActivity();

		expect(result).toEqual({ scanned: 0, dispatched: 0 });
		expect(mocks.getContextVolumeCandidates).not.toHaveBeenCalled();
		expect(mocks.startContextSummarizationWorkflow).not.toHaveBeenCalled();
	});
});

describe("scanAndDispatchContextSummariesActivity — qualification matrix", () => {
	it("dispatches a candidate with NO summary whose raw volume clears the threshold", async () => {
		mocks.getContextVolumeCandidates.mockResolvedValue([makeCandidate()]);
		mocks.getLatestCompletedContextSummary.mockResolvedValue(null);

		const result = await scanAndDispatchContextSummariesActivity();

		expect(result).toEqual({ scanned: 1, dispatched: 1 });
		expect(mocks.startContextSummarizationWorkflow).toHaveBeenCalledTimes(
			1,
		);
		expect(mocks.startContextSummarizationWorkflow).toHaveBeenCalledWith({
			projectId: "proj-1",
			userId: "user-1",
			organizationId: null,
			trigger: "AUTO",
		});
		// No summary → uncovered-volume query is never needed.
		expect(mocks.countRawContextChars).not.toHaveBeenCalled();
	});

	it("skips a candidate whose latest context is at/behind the summary watermark", async () => {
		const coveredThrough = daysAgo(2);
		mocks.getContextVolumeCandidates.mockResolvedValue([
			makeCandidate({ latestContextAt: coveredThrough }),
		]);
		mocks.getLatestCompletedContextSummary.mockResolvedValue({
			coveredThrough,
			engineVersion: ENGINE_VERSION,
		});

		const result = await scanAndDispatchContextSummariesActivity();

		expect(result).toEqual({ scanned: 1, dispatched: 0 });
		expect(mocks.startContextSummarizationWorkflow).not.toHaveBeenCalled();
		// Nothing new since the watermark → we never price the uncovered volume.
		expect(mocks.countRawContextChars).not.toHaveBeenCalled();
	});

	it("dispatches when new context since the watermark clears the token threshold (fresh summary)", async () => {
		const coveredThrough = daysAgo(5); // well within the 30-day stale window
		mocks.getContextVolumeCandidates.mockResolvedValue([
			makeCandidate({ latestContextAt: daysAgo(1) }),
		]);
		mocks.getLatestCompletedContextSummary.mockResolvedValue({
			coveredThrough,
			engineVersion: ENGINE_VERSION,
		});
		// 300k uncovered chars ⇒ 75k tokens ≥ 50k threshold.
		mocks.countRawContextChars.mockResolvedValue(300_000);

		const result = await scanAndDispatchContextSummariesActivity();

		expect(result).toEqual({ scanned: 1, dispatched: 1 });
		expect(mocks.countRawContextChars).toHaveBeenCalledWith({
			projectId: "proj-1",
			after: coveredThrough,
		});
		expect(mocks.startContextSummarizationWorkflow).toHaveBeenCalledTimes(
			1,
		);
	});

	it("dispatches when the uncovered volume is small but the summary is past the stale window", async () => {
		const coveredThrough = daysAgo(40); // older than the 30-day default
		mocks.getContextVolumeCandidates.mockResolvedValue([
			makeCandidate({ latestContextAt: daysAgo(1) }),
		]);
		mocks.getLatestCompletedContextSummary.mockResolvedValue({
			coveredThrough,
			engineVersion: ENGINE_VERSION,
		});
		// 1k uncovered chars ⇒ 250 tokens, far below threshold — staleness is
		// the only thing that can trigger this one.
		mocks.countRawContextChars.mockResolvedValue(1_000);

		const result = await scanAndDispatchContextSummariesActivity();

		expect(result).toEqual({ scanned: 1, dispatched: 1 });
		expect(mocks.startContextSummarizationWorkflow).toHaveBeenCalledTimes(
			1,
		);
	});

	it("rebuilds a LEGACY (v1) summary regardless of its untrustworthy watermark", async () => {
		// A legacy summary's watermark is over-advanced, so latestContextAt would
		// read as "<= coveredThrough" (nothing new) — but the engine-version gate
		// must force a rebuild anyway, and without pricing the uncovered volume.
		mocks.getContextVolumeCandidates.mockResolvedValue([
			makeCandidate({ latestContextAt: daysAgo(1) }),
		]);
		mocks.getLatestCompletedContextSummary.mockResolvedValue({
			coveredThrough: daysAgo(0), // "now" — the buggy over-advanced watermark
			engineVersion: 1,
		});

		const result = await scanAndDispatchContextSummariesActivity();

		expect(result).toEqual({ scanned: 1, dispatched: 1 });
		expect(mocks.startContextSummarizationWorkflow).toHaveBeenCalledTimes(
			1,
		);
		// Legacy short-circuit returns before the uncovered-volume query.
		expect(mocks.countRawContextChars).not.toHaveBeenCalled();
	});

	it("skips when new context is small AND the summary is still fresh (neither branch fires)", async () => {
		const coveredThrough = daysAgo(5);
		mocks.getContextVolumeCandidates.mockResolvedValue([
			makeCandidate({ latestContextAt: daysAgo(1) }),
		]);
		mocks.getLatestCompletedContextSummary.mockResolvedValue({
			coveredThrough,
			engineVersion: ENGINE_VERSION,
		});
		mocks.countRawContextChars.mockResolvedValue(1_000);

		const result = await scanAndDispatchContextSummariesActivity();

		expect(result).toEqual({ scanned: 1, dispatched: 0 });
		expect(mocks.startContextSummarizationWorkflow).not.toHaveBeenCalled();
	});

	it("counts scanned but not dispatched when the dispatcher dedupes (started: false)", async () => {
		mocks.getContextVolumeCandidates.mockResolvedValue([makeCandidate()]);
		mocks.startContextSummarizationWorkflow.mockResolvedValue({
			workflowId: "context-summarization-proj-1",
			started: false,
		});

		const result = await scanAndDispatchContextSummariesActivity();

		expect(mocks.startContextSummarizationWorkflow).toHaveBeenCalledTimes(
			1,
		);
		expect(result).toEqual({ scanned: 1, dispatched: 0 });
	});
});

describe("scanAndDispatchContextSummariesActivity — sweep resilience", () => {
	it("one candidate throwing does not abort evaluation of the rest", async () => {
		const boom = makeCandidate({ projectId: "proj-boom" });
		const ok = makeCandidate({ projectId: "proj-ok" });
		mocks.getContextVolumeCandidates.mockResolvedValue([boom, ok]);
		// First candidate's refinement query throws; second resolves (no summary
		// → qualifies on raw volume).
		mocks.getLatestCompletedContextSummary
			.mockRejectedValueOnce(new Error("db blip"))
			.mockResolvedValueOnce(null);

		const result = await scanAndDispatchContextSummariesActivity();

		expect(result).toEqual({ scanned: 2, dispatched: 1 });
		expect(mocks.startContextSummarizationWorkflow).toHaveBeenCalledTimes(
			1,
		);
		expect(mocks.startContextSummarizationWorkflow).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "proj-ok" }),
		);
	});
});

describe("scanAndDispatchContextSummariesActivity — env overrides", () => {
	it("passes minChars = tokenThreshold × 4 using CONTEXT_SUMMARIZATION_TOKEN_THRESHOLD", async () => {
		process.env.CONTEXT_SUMMARIZATION_TOKEN_THRESHOLD = "10000";
		mocks.getContextVolumeCandidates.mockResolvedValue([]);

		await scanAndDispatchContextSummariesActivity();

		expect(mocks.getContextVolumeCandidates).toHaveBeenCalledWith({
			minChars: 40_000,
		});
	});

	it("honors CONTEXT_SUMMARIZATION_STALE_DAYS so a shorter window dispatches", async () => {
		process.env.CONTEXT_SUMMARIZATION_STALE_DAYS = "7";
		const coveredThrough = daysAgo(10); // < 30 (default skip) but >= 7 (override)
		mocks.getContextVolumeCandidates.mockResolvedValue([
			makeCandidate({ latestContextAt: daysAgo(1) }),
		]);
		mocks.getLatestCompletedContextSummary.mockResolvedValue({
			coveredThrough,
			engineVersion: ENGINE_VERSION,
		});
		mocks.countRawContextChars.mockResolvedValue(1_000); // small uncovered

		const result = await scanAndDispatchContextSummariesActivity();

		expect(result).toEqual({ scanned: 1, dispatched: 1 });
	});

	it("falls back to defaults for non-positive / non-numeric overrides", async () => {
		process.env.CONTEXT_SUMMARIZATION_TOKEN_THRESHOLD = "not-a-number";
		mocks.getContextVolumeCandidates.mockResolvedValue([]);

		await scanAndDispatchContextSummariesActivity();

		// Default 50k tokens ⇒ 200k chars.
		expect(mocks.getContextVolumeCandidates).toHaveBeenCalledWith({
			minChars: 200_000,
		});
	});
});
