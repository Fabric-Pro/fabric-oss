/**
 * Unit tests for Document Generator State Module
 */

import { describe, expect, it } from "vitest";
import type { AgentState } from "../state";
import { AgentStateAnnotation } from "../state";

describe("State Module", () => {
	describe("AgentStateAnnotation", () => {
		it("should be defined", () => {
			expect(AgentStateAnnotation).toBeDefined();
		});

		it("should have spec property for state definition", () => {
			expect(AgentStateAnnotation.spec).toBeDefined();
		});

		it("should define document annotation", () => {
			expect(AgentStateAnnotation.spec.document).toBeDefined();
		});

		it("should define focusAnchor annotation", () => {
			expect(AgentStateAnnotation.spec.focusAnchor).toBeDefined();
		});

		it("should define documentType annotation", () => {
			expect(AgentStateAnnotation.spec.documentType).toBeDefined();
		});

		it("should define systemPrompt annotation", () => {
			expect(AgentStateAnnotation.spec.systemPrompt).toBeDefined();
		});

		it("should define tools annotation", () => {
			expect(AgentStateAnnotation.spec.tools).toBeDefined();
		});

		it("should define error annotation", () => {
			expect(AgentStateAnnotation.spec.error).toBeDefined();
		});

		it("should define retryCount annotation", () => {
			expect(AgentStateAnnotation.spec.retryCount).toBeDefined();
		});

		it("should define messages annotation", () => {
			expect(AgentStateAnnotation.spec.messages).toBeDefined();
		});

		describe("reasoningByTurn", () => {
			/**
			 * Asserts the reasoningByTurn channel is wired into the document
			 * generator state the same way as backlog-updater (so the
			 * CopilotKit STATE_SNAPSHOT contract is consistent across agents).
			 *
			 * The runtime channel shape follows LangGraph 1.x
			 * `BinaryOperatorAggregate`: `operator` is the reducer fn,
			 * `initialValueFactory` is the default fn.
			 */
			type AggregateChannel = {
				operator: (
					a: Record<number, unknown> | undefined,
					b: Record<number, unknown> | undefined,
				) => Record<number, unknown>;
				initialValueFactory: () => Record<number, unknown>;
			};

			it("declares reasoningByTurn in the state spec", () => {
				expect(AgentStateAnnotation.spec.reasoningByTurn).toBeDefined();
			});

			it("defaults to empty record", () => {
				const channel = AgentStateAnnotation.spec
					.reasoningByTurn as unknown as AggregateChannel;
				expect(channel.initialValueFactory()).toEqual({});
			});

			it("merges incoming entries with existing (no overwrite of unrelated keys)", () => {
				const channel = AgentStateAnnotation.spec
					.reasoningByTurn as unknown as AggregateChannel;
				const merged = channel.operator(
					{
						1: {
							text: "a",
							durationMs: 1,
							startedAt: 0,
							completedAt: 1,
						},
					},
					{
						2: {
							text: "b",
							durationMs: 2,
							startedAt: 1,
							completedAt: 3,
						},
					},
				);
				expect(merged).toEqual({
					1: {
						text: "a",
						durationMs: 1,
						startedAt: 0,
						completedAt: 1,
					},
					2: {
						text: "b",
						durationMs: 2,
						startedAt: 1,
						completedAt: 3,
					},
				});
			});

			it("overwrites same-key entries (mid-turn merge from chat-node side)", () => {
				const channel = AgentStateAnnotation.spec
					.reasoningByTurn as unknown as AggregateChannel;
				const merged = channel.operator(
					{
						1: {
							text: "old",
							durationMs: 1,
							startedAt: 0,
							completedAt: 1,
						},
					},
					{
						1: {
							text: "new",
							durationMs: 2,
							startedAt: 0,
							completedAt: 2,
						},
					},
				);
				expect(
					(merged as Record<number, { text: string }>)[1].text,
				).toBe("new");
			});
		});
	});

	describe("State Type", () => {
		it("should allow creating a minimal state object", () => {
			const state: Partial<AgentState> = {
				messages: [],
				documentType: "general",
			};
			expect(state.documentType).toBe("general");
		});

		it("should allow all document types", () => {
			const types = ["general", "technical", "blog", "documentation"];
			for (const type of types) {
				const state: Partial<AgentState> = {
					documentType: type as AgentState["documentType"],
				};
				expect(state.documentType).toBe(type);
			}
		});
	});
});
