/**
 * Workflow-level tests for `glossyEditionBuildWorkflow` (Fizzy #2589, KTD3,
 * KTD4, KTD9): the orchestration of a Glossy build over mocked activities.
 *
 * Harness follows the other light workflow tests in this package
 * (`context-summarization-workflow.test.ts`): `proxyActivities` returns plain
 * `vi.fn()` stubs and `log` is inert, and the workflow runs as an ordinary
 * async function. The failure classes stay real, so an activity failure has
 * the same `ActivityFailure` → `ApplicationFailure` shape Temporal delivers.
 * Retries are Temporal's, not the workflow's, so they are pinned through the
 * retry policies the proxies declare. Replay is covered by the replay suite.
 *
 * What this pins:
 *  - prepare, detection, a bounded pool of rewrites and extractions, then
 *    finalize, and the pool never runs more than four activities at once;
 *  - detection runs only when prepare asks, over the sections it names;
 *  - every activity has a retry policy with a maximum attempt count, the
 *    model activities retry transient errors, and every verdict code stops
 *    at its first attempt;
 *  - a failure routes to fail-build with its code (AE6), and a superseded
 *    run stops scheduling, writes no failure, and reports `superseded`;
 *  - progress (sections done and total) travels with every activity.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => ({
	prepareGlossyBuildActivity: vi.fn(),
	detectGlossyOpportunitiesActivity: vi.fn(),
	rewriteGlossySectionActivity: vi.fn(),
	extractGlossyVisualActivity: vi.fn(),
	finalizeGlossyBuildActivity: vi.fn(),
	failGlossyBuildActivity: vi.fn(),
}));

const captured = vi.hoisted(() => ({
	bags: [] as Array<Record<string, unknown>>,
}));

vi.mock("@temporalio/workflow", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@temporalio/workflow")>();
	return {
		...actual,
		proxyActivities: vi.fn((options: Record<string, unknown>) => {
			captured.bags.push(options);
			return stubs;
		}),
		log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		CancellationScope: {
			nonCancellable: (fn: () => Promise<unknown>) => fn(),
		},
	};
});

import { RetryState } from "@temporalio/common";
import {
	ActivityFailure,
	ApplicationFailure,
	CancelledFailure,
} from "@temporalio/workflow";
import type {
	ExtractGlossyVisualActivityInput,
	GlossyEditionBuildWorkflowInput,
	PrepareGlossyBuildResult,
	RewriteGlossySectionActivityInput,
} from "../../activities/glossy-edition/types";
import { GLOSSY_BUILD_NON_RETRYABLE_ERROR_TYPES } from "../ai-non-retryable-errors";
import {
	GLOSSY_BUILD_POOL_SIZE,
	glossyEditionBuildWorkflow,
} from "../glossy-edition-build";

const INPUT: GlossyEditionBuildWorkflowInput = {
	buildId: "build-1",
	documentId: "doc-1",
	projectId: "proj-1",
	organizationId: "org-1",
	startedById: "user-1",
	options: { mode: "roll_the_dice", lengthMode: "brief" },
};

const REF = {
	buildId: "build-1",
	documentId: "doc-1",
	projectId: "proj-1",
	organizationId: "org-1",
	startedById: "user-1",
};

function plan(
	overrides: Partial<PrepareGlossyBuildResult> = {},
): PrepareGlossyBuildResult {
	return {
		documentType: "BUSINESS_CASE",
		sectionKeys: ["s1", "s2", "s3"],
		slots: [],
		opportunities: [],
		detection: null,
		...overrides,
	};
}

/** What Temporal hands the workflow when an activity throws `ApplicationFailure`. */
function activityFailure(type: string, activityType = "someActivity") {
	return new ActivityFailure(
		"Activity task failed",
		activityType,
		"1",
		RetryState.NON_RETRYABLE_FAILURE,
		"worker@example",
		ApplicationFailure.nonRetryable(`fixed message for ${type}`, type),
	);
}

function stubHappyActivities() {
	stubs.rewriteGlossySectionActivity.mockImplementation(
		async (input: RewriteGlossySectionActivityInput) => ({
			sectionKey: input.sectionKey,
			outcome: "rewritten",
			cacheKey: `rw-${input.sectionKey}`,
			fromCache: false,
		}),
	);
	stubs.extractGlossyVisualActivity.mockImplementation(
		async (input: ExtractGlossyVisualActivityInput) => ({
			sectionKey: input.sectionKey,
			slotId: input.slotId,
			visualKey: `vk-${input.sectionKey}-${input.slotId ?? input.kind}`,
			outcome: "extracted",
			kind: input.kind === "auto" ? "stat" : input.kind,
			cacheKey: `ex-${input.sectionKey}`,
			fromCache: false,
		}),
	);
	stubs.finalizeGlossyBuildActivity.mockResolvedValue({
		outcome: "applied",
		editionId: "edition-1",
		contentRevision: 3,
	});
	stubs.failGlossyBuildActivity.mockResolvedValue({
		outcome: "applied",
		code: "BUILD_FAILED",
	});
}

/** Let every pending microtask chain settle. */
async function flush() {
	for (let i = 0; i < 20; i++) {
		await Promise.resolve();
	}
}

beforeEach(() => {
	for (const stub of Object.values(stubs)) {
		stub.mockReset();
	}
	stubHappyActivities();
});

describe("glossyEditionBuildWorkflow — happy path", () => {
	it("runs prepare, then the pool, then finalize, and reports the published edition", async () => {
		stubs.prepareGlossyBuildActivity.mockResolvedValue(
			plan({
				slots: [
					{ slotId: "slot-1", sectionKey: "s2", kind: "timeline" },
				],
				opportunities: [{ sectionKey: "s1", kind: "stat" }],
			}),
		);

		const output = await glossyEditionBuildWorkflow(INPUT);

		expect(output).toEqual({
			status: "succeeded",
			editionId: "edition-1",
			contentRevision: 3,
		});
		expect(stubs.prepareGlossyBuildActivity).toHaveBeenCalledWith({
			...REF,
			options: INPUT.options,
		});
		expect(stubs.detectGlossyOpportunitiesActivity).not.toHaveBeenCalled();
		expect(
			stubs.rewriteGlossySectionActivity.mock.calls.map(
				([input]) => input.sectionKey,
			),
		).toEqual(["s1", "s2", "s3"]);
		expect(
			stubs.extractGlossyVisualActivity.mock.calls.map(([input]) => [
				input.sectionKey,
				input.kind,
				input.slotId,
			]),
		).toEqual([
			["s2", "timeline", "slot-1"],
			["s1", "stat", null],
		]);

		expect(stubs.finalizeGlossyBuildActivity).toHaveBeenCalledTimes(1);
		const finalize = stubs.finalizeGlossyBuildActivity.mock.calls[0][0];
		expect(finalize).toMatchObject({
			...REF,
			documentType: "BUSINESS_CASE",
			options: INPUT.options,
			detectionCacheKey: null,
		});
		expect(
			finalize.rewrites.map((r: { sectionKey: string }) => r.sectionKey),
		).toEqual(["s1", "s2", "s3"]);
		expect(finalize.visuals).toHaveLength(2);
		expect(stubs.failGlossyBuildActivity).not.toHaveBeenCalled();
	});

	it("passes the style direction and length mode to the model activities", async () => {
		stubs.prepareGlossyBuildActivity.mockResolvedValue(
			plan({
				sectionKeys: ["s1"],
				opportunities: [{ sectionKey: "s1", kind: "flow" }],
			}),
		);

		await glossyEditionBuildWorkflow({
			...INPUT,
			options: {
				mode: "align_first",
				lengthMode: "standard",
				styleDirection: "Calm, navy accents",
			},
		});

		expect(stubs.rewriteGlossySectionActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				lengthMode: "standard",
				sectionKey: "s1",
			}),
		);
		expect(stubs.extractGlossyVisualActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				styleDirection: "Calm, navy accents",
				kind: "flow",
				slotId: null,
			}),
		);
	});

	it("detects only when prepare asks, over the sections it names, and extracts in document order", async () => {
		stubs.prepareGlossyBuildActivity.mockResolvedValue(
			plan({
				sectionKeys: ["s1", "s2", "s3"],
				// Pinned from the published edition: s3 is unchanged.
				opportunities: [{ sectionKey: "s3", kind: "timeline" }],
				detection: { sectionKeys: ["s2"], limit: 7 },
			}),
		);
		stubs.detectGlossyOpportunitiesActivity.mockResolvedValue({
			opportunities: [{ sectionKey: "s2", kind: "comparison" }],
			cacheKey: "det-1",
			fromCache: false,
		});

		await glossyEditionBuildWorkflow(INPUT);

		expect(stubs.detectGlossyOpportunitiesActivity).toHaveBeenCalledWith({
			...REF,
			documentType: "BUSINESS_CASE",
			sectionKeys: ["s2"],
			limit: 7,
			progress: { sectionsDone: 0, sectionsTotal: 3 },
		});
		expect(
			stubs.extractGlossyVisualActivity.mock.calls.map(
				([input]) => input.sectionKey,
			),
		).toEqual(["s2", "s3"]);
		expect(stubs.finalizeGlossyBuildActivity).toHaveBeenCalledWith(
			expect.objectContaining({ detectionCacheKey: "det-1" }),
		);
	});

	it("builds an edition with no visuals when nothing was found (AE8)", async () => {
		stubs.prepareGlossyBuildActivity.mockResolvedValue(
			plan({ detection: { sectionKeys: ["s1", "s2", "s3"], limit: 8 } }),
		);
		stubs.detectGlossyOpportunitiesActivity.mockResolvedValue({
			opportunities: [],
			cacheKey: "det-1",
			fromCache: false,
		});

		const output = await glossyEditionBuildWorkflow(INPUT);

		expect(output.status).toBe("succeeded");
		expect(stubs.extractGlossyVisualActivity).not.toHaveBeenCalled();
		expect(stubs.finalizeGlossyBuildActivity).toHaveBeenCalledWith(
			expect.objectContaining({ visuals: [] }),
		);
	});
});

describe("glossyEditionBuildWorkflow — bounded pool", () => {
	it("never runs more than the pool size at once and drains every task", async () => {
		const sectionKeys = Array.from({ length: 9 }, (_, i) => `s${i + 1}`);
		stubs.prepareGlossyBuildActivity.mockResolvedValue(
			plan({
				sectionKeys,
				opportunities: [
					{ sectionKey: "s1", kind: "stat" },
					{ sectionKey: "s4", kind: "flow" },
				],
			}),
		);
		const pending: Array<() => void> = [];
		let inFlight = 0;
		let maxInFlight = 0;
		const gate =
			<T>(result: () => T) =>
			async (): Promise<T> => {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise<void>((resolve) => pending.push(resolve));
				inFlight--;
				return result();
			};
		stubs.rewriteGlossySectionActivity.mockImplementation(
			(input: RewriteGlossySectionActivityInput) =>
				gate(() => ({
					sectionKey: input.sectionKey,
					outcome: "keptOriginal",
					reason: "fact_guard",
				}))(),
		);
		stubs.extractGlossyVisualActivity.mockImplementation(
			(input: ExtractGlossyVisualActivityInput) =>
				gate(() => ({
					sectionKey: input.sectionKey,
					slotId: null,
					visualKey: `vk-${input.sectionKey}`,
					outcome: "dropped",
					kind: input.kind,
					reason: "fact_check",
				}))(),
		);

		const run = glossyEditionBuildWorkflow(INPUT);
		const total = 11; // nine rewrites and two extractions
		let resolved = 0;
		for (;;) {
			await flush();
			if (pending.length === 0) {
				break;
			}
			// Full up to the pool size while work remains, never beyond it.
			expect(inFlight).toBe(
				Math.min(GLOSSY_BUILD_POOL_SIZE, total - resolved),
			);
			pending.shift()?.();
			resolved++;
		}
		await run;

		expect(GLOSSY_BUILD_POOL_SIZE).toBe(4);
		expect(maxInFlight).toBe(GLOSSY_BUILD_POOL_SIZE);
		expect(resolved).toBe(total);
		expect(stubs.finalizeGlossyBuildActivity).toHaveBeenCalledTimes(1);
	});

	it("carries sections done and total with every activity as rewrites complete", async () => {
		stubs.prepareGlossyBuildActivity.mockResolvedValue(
			plan({
				sectionKeys: ["s1", "s2", "s3", "s4", "s5", "s6"],
				opportunities: [{ sectionKey: "s2", kind: "stat" }],
			}),
		);

		await glossyEditionBuildWorkflow(INPUT);

		const rewriteProgress =
			stubs.rewriteGlossySectionActivity.mock.calls.map(
				([input]) => input.progress,
			);
		for (const progress of rewriteProgress) {
			expect(progress.sectionsTotal).toBe(6);
		}
		const done = rewriteProgress.map(
			(progress: { sectionsDone: number }) => progress.sectionsDone,
		);
		// The first four start together; each later one starts after one more
		// rewrite finished, so the count never goes backwards.
		expect(done.slice(0, 4)).toEqual([0, 0, 0, 0]);
		expect(done[4]).toBeGreaterThan(0);
		expect([...done].sort((a, b) => a - b)).toEqual(done);
		const extract = stubs.extractGlossyVisualActivity.mock.calls[0][0];
		expect(extract.progress.sectionsTotal).toBe(6);
		expect(extract.progress.sectionsDone).toBeGreaterThan(0);
	});
});

describe("glossyEditionBuildWorkflow — retry policies", () => {
	it("declares a retry policy with a maximum attempt count on every proxy", async () => {
		expect(captured.bags.length).toBeGreaterThanOrEqual(3);
		for (const bag of captured.bags) {
			const retry = bag.retry as { maximumAttempts?: number } | undefined;
			expect(retry?.maximumAttempts).toBeGreaterThan(0);
			expect(bag.startToCloseTimeout).toBeDefined();
		}
	});

	it("retries a transient model failure but never a verdict (AE6)", async () => {
		const modelBags = captured.bags.filter(
			(bag) => bag.heartbeatTimeout !== undefined,
		);
		expect(modelBags).toHaveLength(1);
		const retry = modelBags[0].retry as {
			maximumAttempts: number;
			nonRetryableErrorTypes: string[];
		};
		expect(retry.maximumAttempts).toBeGreaterThan(1);
		for (const code of GLOSSY_BUILD_NON_RETRYABLE_ERROR_TYPES) {
			expect(retry.nonRetryableErrorTypes).toContain(code);
		}
		expect(retry.nonRetryableErrorTypes).toContain(
			"AIProviderNotConfiguredError",
		);
		// A generic provider hiccup is not named, so Temporal retries it.
		expect(retry.nonRetryableErrorTypes).not.toContain("Error");
	});
});

describe("glossyEditionBuildWorkflow — failure and supersession", () => {
	it("routes a missing AI provider to fail-build before any section work (AE6)", async () => {
		stubs.prepareGlossyBuildActivity.mockRejectedValue(
			activityFailure(
				"AI_PROVIDER_NOT_CONFIGURED",
				"prepareGlossyBuildActivity",
			),
		);
		stubs.failGlossyBuildActivity.mockResolvedValue({
			outcome: "applied",
			code: "AI_PROVIDER_NOT_CONFIGURED",
		});

		const failure = await glossyEditionBuildWorkflow(INPUT).catch(
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(ApplicationFailure);
		expect((failure as ApplicationFailure).type).toBe(
			"AI_PROVIDER_NOT_CONFIGURED",
		);
		expect((failure as ApplicationFailure).nonRetryable).toBe(true);
		expect(stubs.failGlossyBuildActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				...REF,
				code: "AI_PROVIDER_NOT_CONFIGURED",
			}),
		);
		expect(stubs.rewriteGlossySectionActivity).not.toHaveBeenCalled();
		expect(stubs.finalizeGlossyBuildActivity).not.toHaveBeenCalled();
	});

	it("records an unexpected failure as BUILD_FAILED with its message for the log", async () => {
		stubs.prepareGlossyBuildActivity.mockResolvedValue(plan());
		stubs.rewriteGlossySectionActivity.mockRejectedValue(
			new ActivityFailure(
				"Activity task failed",
				"rewriteGlossySectionActivity",
				"2",
				RetryState.MAXIMUM_ATTEMPTS_REACHED,
				"worker@example",
				ApplicationFailure.retryable("provider exploded", "Error"),
			),
		);

		await expect(glossyEditionBuildWorkflow(INPUT)).rejects.toMatchObject({
			type: "BUILD_FAILED",
		});
		const fail = stubs.failGlossyBuildActivity.mock.calls[0][0];
		expect(fail.code).toBe("BUILD_FAILED");
		expect(fail.detail).toContain("provider exploded");
		expect(stubs.finalizeGlossyBuildActivity).not.toHaveBeenCalled();
	});

	it("stops scheduling after a superseded guard and writes no failure", async () => {
		const sectionKeys = Array.from({ length: 8 }, (_, i) => `s${i + 1}`);
		stubs.prepareGlossyBuildActivity.mockResolvedValue(
			plan({ sectionKeys }),
		);
		stubs.rewriteGlossySectionActivity.mockImplementation(
			async (input: RewriteGlossySectionActivityInput) => {
				if (input.sectionKey === "s2") {
					throw activityFailure(
						"SUPERSEDED",
						"rewriteGlossySectionActivity",
					);
				}
				return { sectionKey: input.sectionKey, outcome: "empty" };
			},
		);

		const output = await glossyEditionBuildWorkflow(INPUT);

		expect(output).toEqual({ status: "superseded" });
		// The first pool-full was in flight; nothing new started after s2 failed.
		expect(
			stubs.rewriteGlossySectionActivity.mock.calls.length,
		).toBeLessThanOrEqual(GLOSSY_BUILD_POOL_SIZE + 1);
		expect(stubs.failGlossyBuildActivity).not.toHaveBeenCalled();
		expect(stubs.finalizeGlossyBuildActivity).not.toHaveBeenCalled();
	});

	it("reports superseded when finalize loses the claim", async () => {
		stubs.prepareGlossyBuildActivity.mockResolvedValue(plan());
		stubs.finalizeGlossyBuildActivity.mockResolvedValue({
			outcome: "superseded",
		});

		await expect(glossyEditionBuildWorkflow(INPUT)).resolves.toEqual({
			status: "superseded",
		});
		expect(stubs.failGlossyBuildActivity).not.toHaveBeenCalled();
	});

	it("reports superseded when the failure write finds the claim gone", async () => {
		stubs.prepareGlossyBuildActivity.mockRejectedValue(
			activityFailure("NOT_ELIGIBLE", "prepareGlossyBuildActivity"),
		);
		stubs.failGlossyBuildActivity.mockResolvedValue({
			outcome: "superseded",
			code: "NOT_ELIGIBLE",
		});

		await expect(glossyEditionBuildWorkflow(INPUT)).resolves.toEqual({
			status: "superseded",
		});
	});

	it("still fails the run when the failure write itself cannot be made", async () => {
		stubs.prepareGlossyBuildActivity.mockRejectedValue(
			activityFailure("ACCESS_REVOKED", "prepareGlossyBuildActivity"),
		);
		stubs.failGlossyBuildActivity.mockRejectedValue(
			new Error("database unavailable"),
		);

		await expect(glossyEditionBuildWorkflow(INPUT)).rejects.toMatchObject({
			type: "ACCESS_REVOKED",
		});
	});

	it("records a cancelled run and rethrows the cancellation", async () => {
		const cancelled = new CancelledFailure("cancelled");
		stubs.prepareGlossyBuildActivity.mockRejectedValue(cancelled);

		await expect(glossyEditionBuildWorkflow(INPUT)).rejects.toBe(cancelled);
		expect(stubs.failGlossyBuildActivity).toHaveBeenCalledWith(
			expect.objectContaining({ code: "BUILD_FAILED" }),
		);
	});
});
