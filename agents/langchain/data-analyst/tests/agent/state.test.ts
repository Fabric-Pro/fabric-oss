/**
 * Unit tests for Data Analyst State Annotation
 *
 * Asserts the reasoningByTurn channel is wired into the DataAnalyst
 * state annotation the same way as project-document-generator (so the
 * CopilotKit STATE_SNAPSHOT contract is consistent across agents).
 */

import { describe, it, expect } from "vitest";
import { DataAnalystAnnotation } from "@/lib/agent/graph";

type AggregateChannel = {
	operator: (
		a: Record<number, unknown> | undefined,
		b: Record<number, unknown> | undefined,
	) => Record<number, unknown>;
	initialValueFactory: () => Record<number, unknown>;
};

describe("DataAnalystAnnotation — reasoningByTurn", () => {
	it("declares reasoningByTurn in the state spec", () => {
		expect(DataAnalystAnnotation.spec.reasoningByTurn).toBeDefined();
	});

	it("defaults to empty record", () => {
		const channel = DataAnalystAnnotation.spec
			.reasoningByTurn as unknown as AggregateChannel;
		expect(channel.initialValueFactory()).toEqual({});
	});

	it("merges incoming entries with existing (no overwrite of unrelated keys)", () => {
		const channel = DataAnalystAnnotation.spec
			.reasoningByTurn as unknown as AggregateChannel;
		const merged = channel.operator(
			{ 1: { text: "a", durationMs: 1, startedAt: 0, completedAt: 1 } },
			{ 2: { text: "b", durationMs: 2, startedAt: 1, completedAt: 3 } },
		);
		expect(merged).toEqual({
			1: { text: "a", durationMs: 1, startedAt: 0, completedAt: 1 },
			2: { text: "b", durationMs: 2, startedAt: 1, completedAt: 3 },
		});
	});

	it("overwrites same-key entries (mid-turn merge from agentNode side)", () => {
		const channel = DataAnalystAnnotation.spec
			.reasoningByTurn as unknown as AggregateChannel;
		const merged = channel.operator(
			{ 1: { text: "old", durationMs: 1, startedAt: 0, completedAt: 1 } },
			{ 1: { text: "new", durationMs: 2, startedAt: 0, completedAt: 2 } },
		);
		expect((merged as Record<number, { text: string }>)[1].text).toBe("new");
	});
});
