import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	findFirst: vi.fn(),
	update: vi.fn(),
	generateText: vi.fn(),
	loadSources: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	Output: { object: (spec: unknown) => spec },
	generateText: m.generateText,
	getAIModelWithMetadata: vi.fn(async () => ({
		model: {},
		trackUsage: vi.fn(),
	})),
}));
vi.mock("@repo/database", () => ({
	db: { projectChunkingRun: { findFirst: m.findFirst } },
	getProjectChunkingSettings: vi.fn(),
	getProjectRagSettings: vi.fn(),
	updateProjectChunkingRun: m.update,
}));
vi.mock("@repo/rag", async () => {
	const tuning = await vi.importActual<
		typeof import("@repo/rag/lib/chunking/tuning")
	>("@repo/rag/lib/chunking/tuning");
	return { ...tuning, chunkText: vi.fn(), generateEmbeddings: vi.fn() };
});
vi.mock("../../lib/project-chunking-runs", () => ({
	loadAnalysisSources: m.loadSources,
	currentSettingFor: vi.fn(),
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

import {
	buildChunkingQuestionsActivity,
	finishChunkingAnalysisActivity,
} from "../chunking-analysis";

const scope = {
	runId: "run-1",
	projectId: "p1",
	organizationId: "org-example",
	userId: "user-1",
};

const TYPE = {
	contentType: "backlog",
	sources: 6,
	totalChars: 1000,
	medianChars: 100,
	defaultProfile: "items",
	measurable: true,
};

function plan(mode: "MEASURE" | "TUNE") {
	return {
		stage: "estimate",
		mode,
		estimate: {},
		types: [TYPE],
		sample: { backlog: ["c1"] },
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	m.loadSources.mockResolvedValue([
		{
			id: "c1",
			contentType: "backlog",
			mimeType: "text/markdown",
			filename: "b.md",
			text: "- EX-1 QA signs off the release on Friday.\n- EX-2 Logout",
		},
	]);
});

describe("buildChunkingQuestionsActivity", () => {
	it("keeps only questions whose answer is a passage of the source", async () => {
		m.findFirst.mockResolvedValue({ result: plan("TUNE") });
		m.generateText.mockResolvedValue({
			output: {
				questions: [
					{
						question: "Who signs off the release?",
						answer: "QA signs off the release on Friday.",
					},
					{
						question: "Invented?",
						answer: "This sentence is not in the text at all.",
					},
				],
			},
		});
		const result = await buildChunkingQuestionsActivity(scope);
		expect(result.questions).toBe(1);
		expect(m.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "run-1",
					projectId: "p1",
					organizationId: "org-example",
				},
			}),
		);
		const saved = m.update.mock.calls.at(-1)?.[1].result;
		expect(saved.questions).toEqual([
			{
				sourceId: "c1",
				question: "Who signs off the release?",
				answer: "QA signs off the release on Friday.",
			},
		]);
	});

	it("skips a source whose response does not fit instead of failing the run", async () => {
		m.findFirst.mockResolvedValue({ result: plan("MEASURE") });
		m.generateText.mockRejectedValue(
			Object.assign(new Error("No object generated"), {
				name: "AI_NoObjectGeneratedError",
			}),
		);
		const result = await buildChunkingQuestionsActivity(scope);
		expect(result.questions).toBe(0);
		// Progress is written as each sampled source is read.
		expect(m.update.mock.calls[0]?.[1].progress).toMatchObject({
			stage: "questions",
			done: 0,
		});
		expect(m.update.mock.calls.at(-1)?.[1].result.questions).toEqual([]);
	});
});

describe("finishChunkingAnalysisActivity", () => {
	it("waits for approval after a tune, and finishes a measure without changing the project", async () => {
		m.findFirst.mockResolvedValue({ result: plan("TUNE") });
		await finishChunkingAnalysisActivity({ ...scope, evaluations: [] });
		expect(m.update).toHaveBeenLastCalledWith(
			"run-1",
			expect.objectContaining({ status: "AWAITING_APPROVAL" }),
		);

		m.findFirst.mockResolvedValue({ result: plan("MEASURE") });
		await finishChunkingAnalysisActivity({ ...scope, evaluations: [] });
		expect(m.update).toHaveBeenLastCalledWith(
			"run-1",
			expect.objectContaining({ status: "COMPLETED", finished: true }),
		);
	});

	it("records a failure", async () => {
		await finishChunkingAnalysisActivity({
			...scope,
			evaluations: [],
			error: "boom",
		});
		expect(m.update).toHaveBeenCalledWith(
			"run-1",
			expect.objectContaining({ status: "FAILED", error: "boom" }),
		);
	});
});
