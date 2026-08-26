/**
 * Unit tests for `resolveInitialRunState` — the durability seam that decides how a
 * summarization run starts: RESUME (continue a checkpoint after a worker/deploy
 * interruption), INCREMENTAL (extend a trustworthy prior), or FULL (rebuild). Pure
 * function, so the heavy activity deps are stubbed just to load the module.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/ai/lib/context-summarization/summarize-project-context", () => ({
	foldContextBatch: vi.fn(),
	SYSTEM_GUIDANCE: "guidance",
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@repo/database", () => ({
	CONTEXT_SUMMARY_ENGINE_VERSION: 2,
	SOURCE_SELECTION_KEYS: ["context", "decisions", "roadmap", "codeRepo"],
	parseSummaryReferences: (v: unknown) => (Array.isArray(v) ? v : []),
	// Only an explicit `false` excludes a source; missing/null defaults to on.
	parseSourceSelection: (v: unknown) => {
		const s = (v && typeof v === "object" ? v : {}) as Record<
			string,
			unknown
		>;
		const on = (x: unknown) => x !== false;
		return {
			context: on(s.context),
			decisions: on(s.decisions),
			roadmap: on(s.roadmap),
			codeRepo: on(s.codeRepo),
		};
	},
}));

import {
	isTrustedIncrementalBase,
	resolveInitialRunState,
} from "../generate-summary";

const ALL_ON = {
	context: true,
	decisions: true,
	roadmap: true,
	codeRepo: true,
};

const REF = {
	marker: "S3",
	sourceType: "TEXT",
	sourceId: "ctx-9",
	sourceTimestamp: "2026-07-05T00:00:00.000Z",
	label: "note",
};

describe("resolveInitialRunState", () => {
	it("RESUME: continues from the checkpoint cursor instead of restarting", () => {
		const state = resolveInitialRunState({
			resuming: true,
			checkpoint: {
				content: "partial digest [S3]",
				references: [REF],
				coveredContextCount: 5,
				stats: {
					eligibleSourceCount: 12,
					processedSourceCount: 5,
					deferredSourceCount: 0,
					batchCount: 2,
					inputChars: 100,
					firstProcessedAt: "2026-07-01T00:00:00.000Z",
					lastProcessedAt: "2026-07-05T00:00:00.000Z",
					cursorId: "ctx-9",
					cursorCreatedAt: "2026-07-05T00:00:00.000Z",
					markerSeq: 3,
					incompleteCoverage: false,
				},
			},
			prior: null,
			priorStats: null,
			priorIsTrusted: false,
		});

		expect(state.runningContent).toBe("partial digest [S3]");
		expect(state.cursorId).toBe("ctx-9");
		expect(state.processedCount).toBe(5);
		expect(state.batchCount).toBe(2);
		expect(state.markerSeq).toBe(3);
		expect(state.registry.get("S3")).toEqual(REF);
	});

	it("INCREMENTAL: seeds the digest + counter from a trustworthy prior", () => {
		const state = resolveInitialRunState({
			resuming: false,
			checkpoint: null,
			prior: {
				content: "prior digest",
				references: [REF],
				coveredThrough: new Date("2026-07-05T00:00:00.000Z"),
				model: "gpt-test",
			} as never,
			priorStats: {
				markerSeq: 7,
				cursorId: "ctx-9",
				cursorCreatedAt: "2026-07-05T00:00:00.000Z",
			} as never,
			priorIsTrusted: true,
		});

		expect(state.runningContent).toBe("prior digest");
		expect(state.markerSeq).toBe(7);
		expect(state.cursorId).toBe("ctx-9");
		expect(state.processedCount).toBe(0);
	});

	it("FULL: starts empty when there is no prior and no checkpoint", () => {
		const state = resolveInitialRunState({
			resuming: false,
			checkpoint: null,
			prior: null,
			priorStats: null,
			priorIsTrusted: false,
		});

		expect(state.runningContent).toBe("");
		expect(state.markerSeq).toBe(0);
		expect(state.cursorId).toBeNull();
		expect(state.processedCount).toBe(0);
		expect(state.registry.size).toBe(0);
	});
});

describe("isTrustedIncrementalBase", () => {
	it("true: v2 prior, covered context, same selection → INCREMENTAL", () => {
		expect(
			isTrustedIncrementalBase(
				{ engineVersion: 2, sourceSelection: { ...ALL_ON } },
				ALL_ON,
			),
		).toBe(true);
	});

	it("false: selection differs from the prior → FULL rebuild", () => {
		expect(
			isTrustedIncrementalBase(
				{ engineVersion: 2, sourceSelection: { ...ALL_ON } },
				{ ...ALL_ON, roadmap: false },
			),
		).toBe(false);
	});

	it("false: a context-excluded prior is not a trusted context base", () => {
		expect(
			isTrustedIncrementalBase(
				{
					engineVersion: 2,
					sourceSelection: { ...ALL_ON, context: false },
				},
				{ ...ALL_ON, context: false },
			),
		).toBe(false);
	});

	it("false: a legacy v1 prior is never trusted", () => {
		expect(
			isTrustedIncrementalBase(
				{ engineVersion: 1, sourceSelection: null },
				ALL_ON,
			),
		).toBe(false);
	});

	it("true: a legacy null selection is treated as all-sources for an all-on run", () => {
		expect(
			isTrustedIncrementalBase(
				{ engineVersion: 2, sourceSelection: null },
				ALL_ON,
			),
		).toBe(true);
	});

	it("false: no prior", () => {
		expect(isTrustedIncrementalBase(null, ALL_ON)).toBe(false);
	});
});
