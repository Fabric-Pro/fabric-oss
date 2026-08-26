/**
 * Unit tests for Story Breakdown State Module
 */

import { describe, expect, it } from "vitest";
import { StoryBreakdownState } from "../state";

describe("State Module", () => {
	describe("StoryBreakdownState", () => {
		it("should be defined", () => {
			expect(StoryBreakdownState).toBeDefined();
		});

		it("should have spec property", () => {
			expect(StoryBreakdownState.spec).toBeDefined();
		});

		it("should define messages annotation", () => {
			expect(StoryBreakdownState.spec.messages).toBeDefined();
		});

		it("should define projectName annotation", () => {
			expect(StoryBreakdownState.spec.projectName).toBeDefined();
		});

		it("should define projectDescription annotation", () => {
			expect(StoryBreakdownState.spec.projectDescription).toBeDefined();
		});

		it("should define prdContent annotation", () => {
			expect(StoryBreakdownState.spec.prdContent).toBeDefined();
		});

		it("should define systemPrompt annotation", () => {
			expect(StoryBreakdownState.spec.systemPrompt).toBeDefined();
		});

		it("should define tools annotation", () => {
			expect(StoryBreakdownState.spec.tools).toBeDefined();
		});

		it("should define document annotation", () => {
			expect(StoryBreakdownState.spec.document).toBeDefined();
		});

		it("should define focusAnchor annotation", () => {
			expect(StoryBreakdownState.spec.focusAnchor).toBeDefined();
		});

		it("should define error annotation", () => {
			expect(StoryBreakdownState.spec.error).toBeDefined();
		});

		it("should define retryCount annotation", () => {
			expect(StoryBreakdownState.spec.retryCount).toBeDefined();
		});

		describe("reasoningByTurn", () => {
			/**
			 * Asserts the reasoningByTurn channel is wired into the
			 * StoryBreakdown state and shaped the same way as
			 * project-document-generator (so the CopilotKit STATE_SNAPSHOT
			 * contract is consistent across agents).
			 */
			type AggregateChannel = {
				operator: (
					a: Record<number, unknown> | undefined,
					b: Record<number, unknown> | undefined,
				) => Record<number, unknown>;
				initialValueFactory: () => Record<number, unknown>;
			};

			it("declares reasoningByTurn in the state spec", () => {
				expect(StoryBreakdownState.spec.reasoningByTurn).toBeDefined();
			});

			it("defaults to empty record", () => {
				const channel = StoryBreakdownState.spec
					.reasoningByTurn as unknown as AggregateChannel;
				expect(channel.initialValueFactory()).toEqual({});
			});

			it("merges incoming entries with existing (no overwrite of unrelated keys)", () => {
				const channel = StoryBreakdownState.spec
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

			it("overwrites same-key entries (mid-turn merge from breakdown-node side)", () => {
				const channel = StoryBreakdownState.spec
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
});
