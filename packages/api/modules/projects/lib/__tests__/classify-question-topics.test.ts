import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getAIModelWithMetadata: vi.fn(),
	generateObject: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
	generateObject: mocks.generateObject,
}));

const { classifyQuestionTopics } = await import("../classify-question-topics");

const tenantFilter = { organizationId: "org-1", userId: "user-1" } as const;

beforeEach(() => {
	mocks.getAIModelWithMetadata.mockReset();
	mocks.generateObject.mockReset();
	mocks.getAIModelWithMetadata.mockResolvedValue({ model: {} });
});

describe("classifyQuestionTopics", () => {
	it("returns [] and makes no model call for empty input", async () => {
		const out = await classifyQuestionTopics({
			questions: [],
			tenantFilter,
		});
		expect(out).toEqual([]);
		expect(mocks.getAIModelWithMetadata).not.toHaveBeenCalled();
	});

	it("maps assignments back to the questions by 1-based id", async () => {
		mocks.generateObject.mockResolvedValue({
			object: {
				assignments: [
					{ id: 1, topic: "Tooling & Tech" },
					{ id: 2, topic: "Rollout & Migration" },
				],
			},
		});
		const out = await classifyQuestionTopics({
			questions: ["Which toolkit?", "Feature flag or big bang?"],
			tenantFilter,
		});
		expect(out).toEqual(["Tooling & Tech", "Rollout & Migration"]);
	});

	it("falls back to 'Other' for any question the model didn't label", async () => {
		mocks.generateObject.mockResolvedValue({
			object: { assignments: [{ id: 2, topic: "UX & Design" }] },
		});
		const out = await classifyQuestionTopics({
			questions: ["Unlabelled?", "Where does the panel go?"],
			tenantFilter,
		});
		expect(out).toEqual(["Other", "UX & Design"]);
	});

	it("falls back to all 'Other' when the model call throws", async () => {
		mocks.generateObject.mockRejectedValue(new Error("model down"));
		const out = await classifyQuestionTopics({
			questions: ["a?", "b?"],
			tenantFilter,
		});
		expect(out).toEqual(["Other", "Other"]);
	});
});
