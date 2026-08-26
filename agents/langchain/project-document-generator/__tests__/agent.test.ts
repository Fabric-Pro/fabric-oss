/**
 * Unit tests for Project Document Generator Agent Main Module
 */

import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import {
	AgentStateAnnotation,
	// Prompts
	buildSystemPrompt,
	calculateRetryDelay,
	// Nodes
	chatNode,
	// Utils
	DEFAULT_RECURSION_LIMIT,
	getAgentModel,
	getPredictStateConfig,
	graphMetadata,
	isJsonParseError,
	MAX_JSON_RETRIES,
	MAX_RETRIES,
	MAX_TOOL_ITERATIONS,
	projectDocumentGeneratorGraph,
	shouldContinue,
	sleep,
} from "../agent";

describe("Project Document Generator Agent Module", () => {
	describe("Graph Export", () => {
		it("should export projectDocumentGeneratorGraph", () => {
			expect(projectDocumentGeneratorGraph).toBeDefined();
		});

		it("should have invoke method", () => {
			expect(typeof projectDocumentGeneratorGraph.invoke).toBe(
				"function",
			);
		});

		it("should have stream method", () => {
			expect(typeof projectDocumentGeneratorGraph.stream).toBe(
				"function",
			);
		});
	});

	describe("Graph Metadata", () => {
		it("should export graphMetadata", () => {
			expect(graphMetadata).toBeDefined();
		});

		it("should have correct name", () => {
			expect(graphMetadata.name).toBe("project_document_generator");
		});

		it("should have description", () => {
			expect(graphMetadata.description).toBeTruthy();
			expect(graphMetadata.description.length).toBeGreaterThan(20);
		});

		it("should have version", () => {
			expect(graphMetadata.version).toMatch(/^\d+\.\d+\.\d+$/);
		});

		it("should have capabilities", () => {
			expect(graphMetadata.capabilities).toContain("document-generation");
			expect(graphMetadata.capabilities).toContain("rag-context");
			expect(graphMetadata.capabilities).toContain("project-context");
			expect(graphMetadata.capabilities).toContain("predictive-updates");
			expect(graphMetadata.capabilities).toContain("streaming");
			expect(graphMetadata.capabilities).toContain("ag-ui-protocol");
		});

		it("should have protocols", () => {
			expect(graphMetadata.protocols).toContain("ag-ui");
		});

		it("should support predictive updates", () => {
			expect(graphMetadata.supportsPredictiveUpdates).toBe(true);
		});
	});

	describe("State Export", () => {
		it("should export AgentStateAnnotation", () => {
			expect(AgentStateAnnotation).toBeDefined();
		});

		it("should have spec property", () => {
			expect(AgentStateAnnotation.spec).toBeDefined();
		});
	});

	describe("Utility Exports", () => {
		it("should export DEFAULT_RECURSION_LIMIT", () => {
			expect(DEFAULT_RECURSION_LIMIT).toBe(50);
		});

		it("should export MAX_RETRIES", () => {
			expect(MAX_RETRIES).toBe(5);
		});

		it("should export MAX_JSON_RETRIES", () => {
			expect(MAX_JSON_RETRIES).toBe(3);
		});

		it("should export getAgentModel", () => {
			expect(typeof getAgentModel).toBe("function");
		});

		it("should export isJsonParseError", () => {
			expect(typeof isJsonParseError).toBe("function");
		});

		it("should export calculateRetryDelay", () => {
			expect(typeof calculateRetryDelay).toBe("function");
		});

		it("should export sleep", () => {
			expect(typeof sleep).toBe("function");
		});
	});

	describe("Prompt Exports", () => {
		it("should export buildSystemPrompt", () => {
			expect(typeof buildSystemPrompt).toBe("function");
		});

		it("should export getPredictStateConfig", () => {
			expect(typeof getPredictStateConfig).toBe("function");
		});
	});

	describe("Node Exports", () => {
		it("should export chatNode", () => {
			expect(typeof chatNode).toBe("function");
		});
	});

	// Routing guard. The synthesized ask_clarifying_question HITL action is
	// handled CLIENT-side by CopilotKit (renderAndWaitForResponse). Like
	// confirm_changes it must end the run so the card renders once and waits;
	// routing it to tool_node (which has no implementation for client actions)
	// produced a chat_node<->tool_node loop that stacked duplicate cards.
	describe("shouldContinue routing", () => {
		const human = new HumanMessage({ content: "hi" });
		const stateWith = (
			toolName: string,
			actions: { name: string }[] = [],
		) =>
			({
				messages: [
					human,
					new AIMessage({
						content: "",
						tool_calls: [
							{
								id: "1",
								name: toolName,
								args: {},
								type: "tool_call" as const,
							},
						],
					}),
				],
				copilotkit: { actions },
			}) as any;

		it("routes synthesized ask_clarifying_question to __end__ even when it is not in copilotkit.actions", () => {
			expect(shouldContinue(stateWith("ask_clarifying_question"))).toBe(
				"__end__",
			);
		});

		it("routes confirm_changes to __end__ (client-side HITL)", () => {
			expect(shouldContinue(stateWith("confirm_changes"))).toBe(
				"__end__",
			);
		});

		it("routes a genuine server-side tool to tool_node", () => {
			expect(shouldContinue(stateWith("search_teams_messages"))).toBe(
				"tool_node",
			);
		});

		it("routes a turn with no tool calls to __end__", () => {
			expect(
				shouldContinue({
					messages: [human],
					copilotkit: { actions: [] },
				} as any),
			).toBe("__end__");
		});

		// The budget relationship with chat_node's finalize mode: the round
		// that spends the budget must still execute (tool_node) so chat_node
		// re-enters at toolRounds === MAX_TOOL_ITERATIONS and finalizes. The
		// backstop only force-ends past the budget — a case chat_node's own
		// finalize guard now absorbs first (issue #2999), so reaching it means
		// the guard's terminal fallback also failed to produce a document.
		const stateWithRounds = (rounds: number) =>
			({
				messages: [
					human,
					...Array.from(
						{ length: rounds },
						(_, i) =>
							new AIMessage({
								content: "",
								tool_calls: [
									{
										id: `${i}`,
										name: "search_teams_messages",
										args: {},
										type: "tool_call" as const,
									},
								],
							}),
					),
				],
				copilotkit: { actions: [] },
			}) as any;

		it("still routes to tool_node at exactly MAX_TOOL_ITERATIONS rounds so the last budgeted round executes", () => {
			expect(shouldContinue(stateWithRounds(MAX_TOOL_ITERATIONS))).toBe(
				"tool_node",
			);
		});

		it("force-ends past MAX_TOOL_ITERATIONS rounds (finalize-mode violation backstop)", () => {
			expect(
				shouldContinue(stateWithRounds(MAX_TOOL_ITERATIONS + 1)),
			).toBe("__end__");
		});
	});
});
