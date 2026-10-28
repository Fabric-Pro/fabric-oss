import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { answerModelInfo } from "../src/answer-model-info";

vi.mock("@temporalio/workflow", () => ({
	proxyActivities: () => ({}),
	log: {},
	ParentClosePolicy: {},
}));

import { buildWorkflowOutput } from "../src/workflows/orchestrator/phases/completion";
import { createInitialState } from "../src/workflows/orchestrator/types";

const snapshot = {
	modelString: "example-served",
	canonicalName: "example-served",
	provider: "OPENAI_CHATGPT_PLAN" as const,
	configId: null,
	configSource: null,
	routeHash: "example-route",
};
describe("served model identity", () => {
	it("marks a plan answer without exposing routing or account data", () => {
		expect(answerModelInfo(snapshot)).toEqual({
			id: "example-served",
			canonicalName: "example-served",
			provider: "OPENAI_CHATGPT_PLAN",
			viaPlan: true,
		});
	});
	it("recognizes plan provenance on snapshots carrying a plan source", () => {
		expect(
			answerModelInfo({
				modelString: "example-plan",
				planSource: { kind: "example" },
				contextWindow: 128000,
			}),
		).toMatchObject({ viaPlan: true, contextWindow: 128000 });
	});

	it("projects the updated fallback and API handoff snapshot rather than the initial pick", () => {
		const metadata = {
			modelString: "example-picked",
			provider: "OPENAI_CHATGPT_PLAN",
			answerSnapshot: snapshot,
		};
		expect(answerModelInfo(metadata.answerSnapshot ?? metadata).id).toBe(
			"example-served",
		);
		metadata.answerSnapshot = {
			...snapshot,
			modelString: "example-api",
			provider: "OPENAI_DIRECT" as never,
		};
		expect(
			answerModelInfo(metadata.answerSnapshot ?? metadata),
		).toMatchObject({ id: "example-api", viaPlan: false });
		const source = readFileSync(
			new URL(
				"../src/activities/direct-chat/ai-execution.ts",
				import.meta.url,
			),
			"utf8",
		);
		expect(source).toContain(
			"model: answerModelInfo(metadata.answerSnapshot ?? metadata)",
		);
	});
	it("adds the Advisor snapshot model to output, and omits it for older state", () => {
		const state = createInitialState({
			executionId: "example-execution",
			userId: "example-user",
			organizationId: "example-org",
			prompt: "Example",
		} as never);
		expect(buildWorkflowOutput(state, "completed")).not.toHaveProperty(
			"model",
		);
		state.advisorAnswerSnapshot = {
			version: 1,
			model: snapshot,
			skills: {
				status: "unavailable",
				descriptors: [],
				systemBlock: null,
				tools: {},
			},
		};
		expect(buildWorkflowOutput(state, "completed").model).toMatchObject({
			id: "example-served",
			viaPlan: true,
		});
	});
});
