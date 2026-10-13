/**
 * The on-demand false-positive review when every shared ChatGPT plan runs out
 * part-way (Fizzy #2770): it stops, fails with the plan's own type carrying
 * the findings it judged, and the retry after the workflow's wait judges only
 * the rest. The auto-review after a scan keeps whatever it judged instead.
 *
 * The real activity runs; only the model call and its neighbours are stubbed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/ai", () => ({
	generateObject: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	logModelUsageAsync: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	createScanFindingReview: vi.fn(),
	DEFAULT_CONFIDENCE_FLOOR: 0.5,
	db: {},
	getBoundPromptForAgent: vi.fn(async () => null),
	getProjectScanConfig: vi.fn(),
	listOpenFindingsForReview: vi.fn(),
	recordScanActivity: vi.fn(),
	updateScanFinding: vi.fn(),
	updateScanFindingReview: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@temporalio/activity", async (importOriginal) => ({
	...(await importOriginal<typeof import("@temporalio/activity")>()),
	heartbeat: vi.fn(),
}));

import { SubscriptionPlanExhaustedError } from "@repo/agent-types/chatgpt-plan-fetch";
import { generateObject, getAIModelWithMetadata } from "@repo/ai";
import { ApplicationFailure } from "@temporalio/activity";
import {
	type FindingReviewProgress,
	runFindingReviewActivity,
} from "../review-activities";
import type { ReviewFindingInput } from "../review-schemas";

const finding = (id: string): ReviewFindingInput => ({
	id,
	category: "SECURITY",
	severity: "MEDIUM",
	title: `Finding ${id}`,
	description: "Description",
	ruleSource: "rule",
	location: null,
	sourceUrl: null,
	confidence: 0.7,
	evidence: null,
});

const INPUT = {
	projectId: "project-1",
	userId: "user-1",
	organizationId: "org-1",
	rubric: "rubric",
	// Two batches of four.
	findings: ["f1", "f2", "f3", "f4", "f5", "f6"].map(finding),
};

/** Which finding a judge call is about, from its prompt. */
function findingOf(call: unknown): string {
	const prompt = (call as { prompt: string }).prompt;
	return /Finding (f\d)/.exec(prompt)?.[1] ?? "?";
}

let spentFor: Set<string>;

beforeEach(() => {
	vi.clearAllMocks();
	spentFor = new Set();
	vi.mocked(getAIModelWithMetadata).mockResolvedValue({
		model: {},
		metadata: { modelString: "model" },
		trackUsage: vi.fn(),
	} as never);
	vi.mocked(generateObject).mockImplementation((async (call: unknown) => {
		const id = findingOf(call);
		if (spentFor.has(id)) {
			throw new SubscriptionPlanExhaustedError("No usage left.", null);
		}
		return {
			object: { verdict: "uncertain", reasoning: id },
			usage: { inputTokens: 2, outputTokens: 1 },
		};
	}) as never);
});

describe("runFindingReviewActivity — every shared plan spent part-way", () => {
	it("stops after the batch that ran out and reports the findings it judged", async () => {
		spentFor.add("f2");

		const failure = await runFindingReviewActivity(INPUT).then(
			() => null,
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(ApplicationFailure);
		const appFailure = failure as ApplicationFailure;
		expect(appFailure.type).toBe("SubscriptionPlanExhaustedError");
		expect(appFailure.nonRetryable).toBe(true);
		const progress = appFailure.details?.[0] as FindingReviewProgress;
		// The first batch ran whole; f2 is left for the retry; the second
		// batch never started.
		expect(progress.judgedFindingIds).toEqual(["f1", "f3", "f4"]);
		expect(progress.proposals.map((p) => p.findingId)).toEqual([
			"f1",
			"f3",
			"f4",
		]);
		expect(progress.inputTokens).toBe(6);
		expect(
			vi
				.mocked(generateObject)
				.mock.calls.map(([call]) => findingOf(call)),
		).toEqual(["f1", "f2", "f3", "f4"]);
	});

	it("judges only the rest on the retry, keeping what the first attempt judged", async () => {
		const resume: FindingReviewProgress = {
			judgedFindingIds: ["f1", "f3", "f4"],
			proposals: ["f1", "f3", "f4"].map((findingId) => ({
				findingId,
				verdict: "uncertain" as const,
				reasoning: findingId,
				confidence: "low" as const,
			})),
			inputTokens: 6,
			outputTokens: 3,
		};

		const output = await runFindingReviewActivity({ ...INPUT, resume });

		expect(
			vi
				.mocked(generateObject)
				.mock.calls.map(([call]) => findingOf(call)),
		).toEqual(["f2", "f5", "f6"]);
		expect(output.reviewedCount).toBe(6);
		expect(output.proposals.map((p) => p.findingId)).toEqual([
			"f1",
			"f3",
			"f4",
			"f2",
			"f5",
			"f6",
		]);
		expect(output.inputTokens).toBe(12);
		expect(output.outputTokens).toBe(6);
	});

	it("passes over a finding whose judge failed for any other reason, as before", async () => {
		vi.mocked(generateObject).mockImplementation((async (call: unknown) => {
			if (findingOf(call) === "f2") {
				throw new Error("gateway 500");
			}
			return {
				object: { verdict: "uncertain" },
				usage: { inputTokens: 2, outputTokens: 1 },
			};
		}) as never);

		const output = await runFindingReviewActivity(INPUT);

		expect(output.reviewedCount).toBe(6);
		expect(output.proposals).toHaveLength(5);
	});
});
