/**
 * Unit tests for Project Document Generator State Module
 */

import { describe, expect, it } from "vitest";
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

		it("should define streamingContent annotation", () => {
			expect(AgentStateAnnotation.spec.streamingContent).toBeDefined();
		});

		it("should define focusAnchor annotation", () => {
			expect(AgentStateAnnotation.spec.focusAnchor).toBeDefined();
		});

		it("should define documentType annotation", () => {
			expect(AgentStateAnnotation.spec.documentType).toBeDefined();
		});

		it("should define projectContext annotation", () => {
			expect(AgentStateAnnotation.spec.projectContext).toBeDefined();
		});

		it("should define ragContexts annotation", () => {
			expect(AgentStateAnnotation.spec.ragContexts).toBeDefined();
		});

		it("should define systemPrompt annotation", () => {
			expect(AgentStateAnnotation.spec.systemPrompt).toBeDefined();
		});

		it("should define copilotkit annotation from CopilotKitStateAnnotation", () => {
			expect(AgentStateAnnotation.spec.copilotkit).toBeDefined();
		});

		it("should define retryCount annotation", () => {
			expect(AgentStateAnnotation.spec.retryCount).toBeDefined();
		});

		it("should define error annotation", () => {
			expect(AgentStateAnnotation.spec.error).toBeDefined();
		});

		it("should define messages annotation", () => {
			expect(AgentStateAnnotation.spec.messages).toBeDefined();
		});
	});
});

describe("AgentStateAnnotation — reasoningByTurn", () => {
	// LangGraph 1.x exposes a Reducer-shaped Annotation as a BinaryOperatorAggregate
	// channel whose runtime fields are `operator` (the reducer fn) and
	// `initialValueFactory` (the default fn). The plan's test text used the
	// authoring-time names (`reducer` / `default`); these tests assert against
	// the actual runtime channel shape that LangGraph hands back.
	it("defaults to empty record", () => {
		const initial =
			AgentStateAnnotation.spec.reasoningByTurn.initialValueFactory?.();
		expect(initial).toEqual({});
	});

	it("merges incoming entries with existing (no overwrite of unrelated keys)", () => {
		const reducer = AgentStateAnnotation.spec.reasoningByTurn.operator;
		const existing = {
			1: {
				text: "first",
				durationMs: 1000,
				startedAt: 0,
				completedAt: 1000,
			},
		};
		const incoming = {
			2: {
				text: "second",
				durationMs: 2000,
				startedAt: 1000,
				completedAt: 3000,
			},
		};

		const merged = reducer(existing, incoming);

		expect(merged).toEqual({
			1: {
				text: "first",
				durationMs: 1000,
				startedAt: 0,
				completedAt: 1000,
			},
			2: {
				text: "second",
				durationMs: 2000,
				startedAt: 1000,
				completedAt: 3000,
			},
		});
	});

	it("overwrites the SAME turn key when incoming has it (allows mid-turn merge from chat-node side)", () => {
		const reducer = AgentStateAnnotation.spec.reasoningByTurn.operator;
		const existing = {
			1: {
				text: "first",
				durationMs: 1000,
				startedAt: 0,
				completedAt: 1000,
			},
		};
		const incoming = {
			1: {
				text: "first+second",
				durationMs: 2500,
				startedAt: 0,
				completedAt: 2500,
			},
		};

		const merged = reducer(existing, incoming);

		expect(merged[1]).toEqual({
			text: "first+second",
			durationMs: 2500,
			startedAt: 0,
			completedAt: 2500,
		});
	});

	it("treats undefined existing/incoming as empty", () => {
		// LangGraph types the reducer args as non-nullable, but the operator we
		// defined explicitly handles undefined on both sides so that early/late
		// writes during graph init don't crash. Cast through unknown to bypass
		// the BinaryOperator<Value, Update> signature for this defensive check.
		const reducer = AgentStateAnnotation.spec.reasoningByTurn
			.operator as unknown as (
			a:
				| Record<
						number,
						{
							text: string;
							durationMs: number;
							startedAt: number;
							completedAt: number;
						}
				  >
				| undefined,
			b:
				| Record<
						number,
						{
							text: string;
							durationMs: number;
							startedAt: number;
							completedAt: number;
						}
				  >
				| undefined,
		) => Record<
			number,
			{
				text: string;
				durationMs: number;
				startedAt: number;
				completedAt: number;
			}
		>;
		expect(
			reducer(undefined, {
				1: { text: "x", durationMs: 1, startedAt: 0, completedAt: 1 },
			}),
		).toEqual({
			1: { text: "x", durationMs: 1, startedAt: 0, completedAt: 1 },
		});
		expect(
			reducer(
				{
					1: {
						text: "y",
						durationMs: 1,
						startedAt: 0,
						completedAt: 1,
					},
				},
				undefined,
			),
		).toEqual({
			1: { text: "y", durationMs: 1, startedAt: 0, completedAt: 1 },
		});
	});
});
