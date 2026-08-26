import { beforeEach, describe, expect, it, vi } from "vitest";

// Bare unit test: Context.current() throws "Activity context not initialized"
// outside a real Temporal activity execution, so the heartbeat interval needs
// Context mocked (mirrors collect-stories.test.ts in this same directory).
vi.mock("@temporalio/activity", () => ({
	Context: {
		current: () => ({
			heartbeat: vi.fn(),
			// `info.workflowExecution` is what `job-progress`'s currentExecution()
			// reads. Without it every Job Hub write below is a silent no-op, and the
			// assertions would be passing on nothing.
			info: {
				workflowExecution: {
					workflowId: "publishing-suggestion-cycle-1",
					runId: "run-1",
				},
			},
		}),
	},
}));

const generateObject = vi.fn();
const getAIModelWithMetadata = vi.fn();
const logModelUsageAsync = vi.fn();
vi.mock("@repo/ai", () => ({
	generateObject: (...a: unknown[]) => generateObject(...a),
	getAIModelWithMetadata: (...a: unknown[]) => getAIModelWithMetadata(...a),
	logModelUsageAsync: (...a: unknown[]) => logModelUsageAsync(...a),
}));

const mockIsCurrentOrgMember = vi.fn();
// Spied at the `@repo/database` boundary so the REAL `job-progress` runs on top.
const setBackgroundJobStep = vi.fn();
vi.mock("@repo/database", async () => {
	const actual =
		await vi.importActual<typeof import("@repo/database")>(
			"@repo/database",
		);
	return {
		...actual,
		isCurrentOrgMember: (...a: unknown[]) => mockIsCurrentOrgMember(...a),
		setBackgroundJobStep: (...a: unknown[]) => setBackgroundJobStep(...a),
	};
});

import { TOTAL_CONTEXT_MAX_BYTES } from "../lib/byte-bound";
import { summarizeTopicSuggestions } from "../summarize-topic-suggestions";

const trackUsage = vi.fn();

function stubModel() {
	getAIModelWithMetadata.mockResolvedValue({
		model: {},
		metadata: { modelString: "test-model", provider: "test" },
		trackUsage,
	});
}

const VALID_TOPIC = {
	title: "Faster onboarding flow",
	pitch: "The onboarding flow now completes in half the steps.",
	provenance: { storyIds: ["story-1"] },
};

beforeEach(() => {
	generateObject.mockReset();
	getAIModelWithMetadata.mockReset();
	logModelUsageAsync.mockReset();
	mockIsCurrentOrgMember.mockReset();
	mockIsCurrentOrgMember.mockResolvedValue(true);
	trackUsage.mockReset();
	setBackgroundJobStep.mockReset();
	stubModel();
});

describe("summarizeTopicSuggestions", () => {
	it("returns the model's topics and usage tokens on the happy path", async () => {
		generateObject.mockResolvedValue({
			object: { topics: [VALID_TOPIC] },
			usage: { totalTokens: 123 },
		});

		const result = await summarizeTopicSuggestions({
			projectId: "proj-a",
			organizationId: null,
			actorUserId: "user-1",
			context: { stories: [{ id: "story-1", title: "Onboarding" }] },
		});

		expect(result.topics).toEqual([
			{
				...VALID_TOPIC,
				suggestedPostTypes: [],
				relevantFunctionTags: [],
				postTypeRecommendations: [],
			},
		]);
		expect(result.aiUsageTokens).toBe(123);
		expect(trackUsage).toHaveBeenCalledTimes(1);
		// Usage recording is the global interceptor's job; this pipeline only
		// supplies the attribution label (Fizzy #1894).
		expect(getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "COMPLEX" },
			{
				userId: "user-1",
				organizationId: undefined,
				jobType: "publishing-suggestion",
			},
		);
	});

	it("does not revalidate membership for a personal (organizationId=null) context", async () => {
		generateObject.mockResolvedValue({
			object: { topics: [] },
			usage: { totalTokens: 1 },
		});

		await summarizeTopicSuggestions({
			projectId: "proj-a",
			organizationId: null,
			actorUserId: "user-1",
			context: {},
		});

		expect(mockIsCurrentOrgMember).not.toHaveBeenCalled();
		expect(generateObject).toHaveBeenCalledTimes(1);
	});

	it("revalidates org membership before model resolution and throws PUBLISHING_ACTOR_INVALID when the actor is no longer a member", async () => {
		mockIsCurrentOrgMember.mockResolvedValue(false);

		await expect(
			summarizeTopicSuggestions({
				projectId: "proj-a",
				organizationId: "org-9",
				actorUserId: "removed-admin",
				context: {},
			}),
		).rejects.toMatchObject({ type: "PUBLISHING_ACTOR_INVALID" });

		expect(mockIsCurrentOrgMember).toHaveBeenCalledWith(
			"removed-admin",
			"org-9",
		);
		expect(getAIModelWithMetadata).not.toHaveBeenCalled();
		expect(generateObject).not.toHaveBeenCalled();
	});

	it("throws PUBLISHING_SCHEMA_VALIDATION_FAILED and never returns when the model output fails schema validation", async () => {
		generateObject.mockResolvedValue({
			object: { topics: [{ title: "", pitch: "", provenance: {} }] }, // title/pitch violate min(1)
			usage: { totalTokens: 5 },
		});

		await expect(
			summarizeTopicSuggestions({
				projectId: "proj-a",
				organizationId: null,
				actorUserId: "user-1",
				context: {},
			}),
		).rejects.toMatchObject({
			type: "PUBLISHING_SCHEMA_VALIDATION_FAILED",
		});
	});

	it("passes the built prompt and resolved model through to generateObject", async () => {
		generateObject.mockResolvedValue({
			object: { topics: [] },
			usage: { totalTokens: 1 },
		});

		await summarizeTopicSuggestions({
			projectId: "proj-a",
			organizationId: "org-1",
			actorUserId: "user-1",
			context: {
				pullRequests: [{ repoFullName: "acme/web", prNumber: 4 }],
			},
		});

		expect(getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "COMPLEX" },
			{
				userId: "user-1",
				organizationId: "org-1",
				jobType: "publishing-suggestion",
			},
		);
		const callArgs = generateObject.mock.calls[0][0] as {
			model: unknown;
			prompt: string;
		};
		expect(callArgs.model).toEqual({});
		expect(callArgs.prompt).toContain("acme/web");
	});

	// Codex round-2 N1: the aggregate context (all 5 source keys combined) must
	// be bounded to TOTAL_CONTEXT_MAX_BYTES before it reaches the prompt, even
	// though each individual collector already respects its own per-source cap.
	it("bounds an oversized aggregate context before building the prompt", async () => {
		generateObject.mockResolvedValue({
			object: { topics: [] },
			usage: { totalTokens: 1 },
		});

		const bigBody = "x".repeat(2000);
		const makeItems = (prefix: string) =>
			Array.from({ length: 150 }, (_, i) => ({
				id: `${prefix}-${i}`,
				body: bigBody,
			}));

		await summarizeTopicSuggestions({
			projectId: "proj-a",
			organizationId: null,
			actorUserId: "user-1",
			context: {
				stories: makeItems("story"),
				documents: makeItems("doc"),
				transcripts: makeItems("transcript"),
				pullRequests: makeItems("pr"),
				releases: makeItems("release"),
			},
		});

		const callArgs = generateObject.mock.calls[0][0] as { prompt: string };
		// The prompt template itself (instructions) plus the bounded context
		// must stay well under what the raw ~1.5MB context would have produced.
		expect(callArgs.prompt.length).toBeLessThan(
			TOTAL_CONTEXT_MAX_BYTES * 2,
		);
		// At least the newest item from the first source survives (recency
		// preserved — collectors return items newest-first, and the bounding
		// cascade trims from the tail).
		expect(callArgs.prompt).toContain("story-0");
	});

	it("normalizes and passes through the model angle (FR9/10)", async () => {
		generateObject.mockResolvedValue({
			object: {
				topics: [
					{
						title: "T1",
						pitch: "P1",
						provenance: {},
						angle: "  Exec summary  ",
					},
					{ title: "T2", pitch: "P2", provenance: {}, angle: 123 },
					{ title: "T3", pitch: "P3", provenance: {} },
				],
			},
			usage: { totalTokens: 10 },
		});
		const out = await summarizeTopicSuggestions({
			projectId: "proj-a",
			organizationId: null,
			actorUserId: "user-1",
			context: {},
		});
		expect(out.topics[0].angle).toBe("Exec summary");
		expect(out.topics[1].angle).toBeUndefined();
		expect(out.topics[2].angle).toBeUndefined();
	});

	it("normalizes and passes through the subject field", async () => {
		generateObject.mockResolvedValue({
			object: {
				topics: [
					{
						title: "T1",
						pitch: "p",
						provenance: {},
						subject: "  Shipped RLS  ",
					},
					{
						title: "T2",
						pitch: "p",
						provenance: {},
						subject: "x".repeat(200),
					},
					{ title: "T3", pitch: "p", provenance: {} },
				],
			},
			usage: { totalTokens: 1 },
		});
		const res = await summarizeTopicSuggestions({
			projectId: "proj-1",
			organizationId: null,
			actorUserId: "user-1",
			context: {},
		});
		expect(res.topics[0].subject).toBe("Shipped RLS");
		expect(res.topics[1].subject).toHaveLength(120); // SUBJECT_MAX
		expect(res.topics[2].subject).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Job Hub steps (Fizzy #1850)
// ---------------------------------------------------------------------------
const JOB_INPUT = {
	projectId: "proj-a",
	organizationId: null,
	actorUserId: "user-1",
	context: { stories: [{ id: "story-1", title: "Onboarding" }] },
};

/** Just the (stepKey, status) pairs, in call order. */
const stepCalls = () =>
	setBackgroundJobStep.mock.calls.map((c) => [c[1], c[2]]);

describe("summarizeTopicSuggestions — Job Hub steps", () => {
	it("completes collect as it starts, and drives summarize through running to completed", async () => {
		generateObject.mockResolvedValue({
			object: { topics: [VALID_TOPIC] },
			usage: { totalTokens: 5 },
		});

		await summarizeTopicSuggestions(JOB_INPUT);

		// `collect` is completed HERE as well as in persistCycleTerminal: on this
		// path the summarizer runs, so completing it here stops the panel showing
		// `collect: running` beside `summarize: completed` — an ordering a reader
		// would take for a bug.
		expect(stepCalls()).toEqual([
			["collect", "completed"],
			["summarize", "running"],
			["summarize", "completed"],
		]);
		expect(setBackgroundJobStep).toHaveBeenCalledWith(
			{
				workflowId: "publishing-suggestion-cycle-1",
				sourceId: null,
			},
			"collect",
			"completed",
			undefined,
		);
	});

	it("marks summarize FAILED and never completed, because the close sweep records a reached-and-failed step as skipped", async () => {
		generateObject.mockRejectedValue(new Error("model unavailable"));

		await expect(summarizeTopicSuggestions(JOB_INPUT)).rejects.toThrow(
			"model unavailable",
		);

		// The WHOLE sequence, not merely the presence of `failed`: asserting only
		// that `failed` was written would still pass if `completed` were written
		// on the error path too, which is the defect this guards.
		expect(stepCalls()).toEqual([
			["collect", "completed"],
			["summarize", "running"],
			["summarize", "failed"],
		]);
	});

	it("returns the same summary when the underlying job writer rejects", async () => {
		generateObject.mockResolvedValue({
			object: { topics: [VALID_TOPIC] },
			usage: { totalTokens: 5 },
		});
		setBackgroundJobStep.mockRejectedValue(new Error("db down"));

		await expect(
			summarizeTopicSuggestions(JOB_INPUT),
		).resolves.toMatchObject({ aiUsageTokens: 5 });
	});
});
