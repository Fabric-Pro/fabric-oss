/**
 * Unit tests for API Agent State Module
 */

import { describe, expect, it } from "vitest";
import type { ApiAgentStateType } from "../state";
import { ApiAgentState } from "../state";

describe("State Module", () => {
	describe("ApiAgentState Annotation", () => {
		it("should be defined", () => {
			expect(ApiAgentState).toBeDefined();
		});

		it("should have spec property for state definition", () => {
			expect(ApiAgentState.spec).toBeDefined();
		});

		it("should define messages annotation", () => {
			expect(ApiAgentState.spec.messages).toBeDefined();
		});

		it("should define stage annotation", () => {
			expect(ApiAgentState.spec.stage).toBeDefined();
		});

		it("should define taskDescription annotation", () => {
			expect(ApiAgentState.spec.taskDescription).toBeDefined();
		});

		it("should define context annotation", () => {
			expect(ApiAgentState.spec.context).toBeDefined();
		});

		it("should define availableTools annotation", () => {
			expect(ApiAgentState.spec.availableTools).toBeDefined();
		});

		it("should define fabricApiUrl annotation", () => {
			expect(ApiAgentState.spec.fabricApiUrl).toBeDefined();
		});

		it("should define userId annotation", () => {
			expect(ApiAgentState.spec.userId).toBeDefined();
		});

		it("should define organizationId annotation", () => {
			expect(ApiAgentState.spec.organizationId).toBeDefined();
		});

		it("should define selectedTool annotation", () => {
			expect(ApiAgentState.spec.selectedTool).toBeDefined();
		});

		it("should define toolArguments annotation", () => {
			expect(ApiAgentState.spec.toolArguments).toBeDefined();
		});

		it("should define executionResult annotation", () => {
			expect(ApiAgentState.spec.executionResult).toBeDefined();
		});

		it("should define response annotation", () => {
			expect(ApiAgentState.spec.response).toBeDefined();
		});

		it("should define error annotation", () => {
			expect(ApiAgentState.spec.error).toBeDefined();
		});
	});

	describe("State Type", () => {
		it("should allow creating a minimal state object", () => {
			const state: Partial<ApiAgentStateType> = {
				messages: [],
				stage: "analyzing",
			};
			expect(state.stage).toBe("analyzing");
		});

		it("should allow all stage values", () => {
			const stages = [
				"analyzing",
				"executing",
				"formatting",
				"complete",
				"error",
			];
			for (const stage of stages) {
				const state: Partial<ApiAgentStateType> = {
					stage: stage as ApiAgentStateType["stage"],
				};
				expect(state.stage).toBe(stage);
			}
		});
	});
});
