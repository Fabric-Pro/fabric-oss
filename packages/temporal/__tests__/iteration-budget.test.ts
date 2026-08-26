/**
 * Iteration Budget Tests
 *
 * Tests for iterative mode budget enforcement:
 * - Token limit enforcement
 * - Iteration limit enforcement
 * - Budget tracking and reporting
 * - Cost calculation
 */

import { describe, expect, it } from "vitest";
import {
	checkIterationBudget,
	type IterationCost,
} from "../src/activities/orchestrator/execution/token-budget";

describe("checkIterationBudget", () => {
	describe("Token Budget Enforcement", () => {
		it("should allow execution when within token budget", () => {
			const costs: IterationCost[] = [
				{
					iteration: 1,
					inputTokens: 1000,
					outputTokens: 500,
					timestamp: new Date().toISOString(),
				},
				{
					iteration: 2,
					inputTokens: 1200,
					outputTokens: 600,
					timestamp: new Date().toISOString(),
				},
			];

			const result = checkIterationBudget(costs, {
				maxTotalTokens: 10000,
				maxIterations: 15,
			});

			expect(result.withinBudget).toBe(true);
			expect(result.totalTokensUsed).toBe(3300); // 1000+500+1200+600
			expect(result.remainingTokens).toBe(6700);
			expect(result.reason).toBeUndefined();
		});

		it("should reject execution when token budget exceeded", () => {
			const costs: IterationCost[] = [
				{
					iteration: 1,
					inputTokens: 5000,
					outputTokens: 3000,
					timestamp: new Date().toISOString(),
				},
				{
					iteration: 2,
					inputTokens: 2500,
					outputTokens: 1500,
					timestamp: new Date().toISOString(),
				},
			];

			const result = checkIterationBudget(costs, {
				maxTotalTokens: 10000,
				maxIterations: 15,
			});

			expect(result.withinBudget).toBe(false);
			expect(result.totalTokensUsed).toBe(12000);
			expect(result.reason).toContain("Token budget exceeded");
			expect(result.reason).toContain("12,000/10,000");
			expect(result.remainingTokens).toBe(0);
		});

		it("should use default max tokens when not specified", () => {
			const costs: IterationCost[] = [
				{
					iteration: 1,
					inputTokens: 50000,
					outputTokens: 30000,
					timestamp: new Date().toISOString(),
				},
			];

			const result = checkIterationBudget(costs, {});

			expect(result.withinBudget).toBe(true); // Default is 200000
			expect(result.totalTokensUsed).toBe(80000);
			expect(result.remainingTokens).toBe(120000);
		});

		it("should handle edge case of exactly at budget limit", () => {
			const costs: IterationCost[] = [
				{
					iteration: 1,
					inputTokens: 6000,
					outputTokens: 4000,
					timestamp: new Date().toISOString(),
				},
			];

			const result = checkIterationBudget(costs, {
				maxTotalTokens: 10000,
				maxIterations: 15,
			});

			expect(result.withinBudget).toBe(true);
			expect(result.totalTokensUsed).toBe(10000);
			expect(result.remainingTokens).toBe(0);
		});

		it("should handle empty cost array", () => {
			const result = checkIterationBudget([], {
				maxTotalTokens: 10000,
				maxIterations: 15,
			});

			expect(result.withinBudget).toBe(true);
			expect(result.totalTokensUsed).toBe(0);
			expect(result.remainingTokens).toBe(10000);
			expect(result.iterationsUsed).toBe(0);
			expect(result.remainingIterations).toBe(15);
		});
	});

	describe("Iteration Limit Enforcement", () => {
		it("should allow execution when within iteration limit", () => {
			const costs: IterationCost[] = Array.from(
				{ length: 5 },
				(_, i) => ({
					iteration: i + 1,
					inputTokens: 100,
					outputTokens: 50,
					timestamp: new Date().toISOString(),
				}),
			);

			const result = checkIterationBudget(costs, {
				maxTotalTokens: 10000,
				maxIterations: 15,
			});

			expect(result.withinBudget).toBe(true);
			expect(result.iterationsUsed).toBe(5);
			expect(result.remainingIterations).toBe(10);
		});

		it("should reject execution when iteration limit reached", () => {
			const costs: IterationCost[] = Array.from(
				{ length: 15 },
				(_, i) => ({
					iteration: i + 1,
					inputTokens: 100,
					outputTokens: 50,
					timestamp: new Date().toISOString(),
				}),
			);

			const result = checkIterationBudget(costs, {
				maxTotalTokens: 100000,
				maxIterations: 15,
			});

			expect(result.withinBudget).toBe(false);
			expect(result.iterationsUsed).toBe(15);
			expect(result.reason).toContain("Iteration limit reached");
			expect(result.reason).toContain("15/15");
			expect(result.remainingIterations).toBe(0);
		});

		it("should use default max iterations when not specified", () => {
			const costs: IterationCost[] = Array.from(
				{ length: 10 },
				(_, i) => ({
					iteration: i + 1,
					inputTokens: 100,
					outputTokens: 50,
					timestamp: new Date().toISOString(),
				}),
			);

			const result = checkIterationBudget(costs, {});

			expect(result.withinBudget).toBe(true); // Default is 25
			expect(result.iterationsUsed).toBe(10);
			expect(result.remainingIterations).toBe(15);
		});

		it("should handle edge case of exactly at iteration limit", () => {
			const costs: IterationCost[] = Array.from(
				{ length: 15 },
				(_, i) => ({
					iteration: i + 1,
					inputTokens: 100,
					outputTokens: 50,
					timestamp: new Date().toISOString(),
				}),
			);

			const result = checkIterationBudget(costs, {
				maxTotalTokens: 100000,
				maxIterations: 15,
			});

			expect(result.withinBudget).toBe(false);
			expect(result.iterationsUsed).toBe(15);
			expect(result.remainingIterations).toBe(0);
		});
	});

	describe("Priority: Token Budget vs Iteration Limit", () => {
		it("should fail on token budget even if iterations are available", () => {
			const costs: IterationCost[] = [
				{
					iteration: 1,
					inputTokens: 8000,
					outputTokens: 5000,
					timestamp: new Date().toISOString(),
				},
			];

			const result = checkIterationBudget(costs, {
				maxTotalTokens: 10000,
				maxIterations: 15,
			});

			expect(result.withinBudget).toBe(false);
			expect(result.reason).toContain("Token budget exceeded");
			expect(result.iterationsUsed).toBe(1);
			expect(result.remainingIterations).toBe(14); // Still have iterations available
		});

		it("should fail on iteration limit even if tokens are available", () => {
			const costs: IterationCost[] = Array.from(
				{ length: 20 },
				(_, i) => ({
					iteration: i + 1,
					inputTokens: 50,
					outputTokens: 30,
					timestamp: new Date().toISOString(),
				}),
			);

			const result = checkIterationBudget(costs, {
				maxTotalTokens: 100000,
				maxIterations: 20,
			});

			expect(result.withinBudget).toBe(false);
			expect(result.reason).toContain("Iteration limit reached");
			expect(result.totalTokensUsed).toBe(1600); // 80 * 20
			expect(result.remainingTokens).toBe(98400); // Still have tokens available
		});
	});

	describe("Cost Tracking with Tool Names", () => {
		it("should track costs with optional tool names", () => {
			const costs: IterationCost[] = [
				{
					iteration: 1,
					toolName: "search_messages",
					inputTokens: 1000,
					outputTokens: 500,
					timestamp: new Date().toISOString(),
				},
				{
					iteration: 2,
					toolName: "create_task",
					inputTokens: 800,
					outputTokens: 400,
					timestamp: new Date().toISOString(),
				},
				{
					iteration: 3,
					// No tool name (final response)
					inputTokens: 200,
					outputTokens: 800,
					timestamp: new Date().toISOString(),
				},
			];

			const result = checkIterationBudget(costs, {
				maxTotalTokens: 10000,
				maxIterations: 15,
			});

			expect(result.withinBudget).toBe(true);
			expect(result.totalTokensUsed).toBe(3700);
			expect(result.iterationsUsed).toBe(3);
		});
	});

	describe("Real-World Scenarios", () => {
		it("should handle gradual token consumption over many iterations", () => {
			// Simulate a discovery task with gradually increasing token usage
			const costs: IterationCost[] = [
				{ iteration: 1, inputTokens: 500, outputTokens: 200 }, // List teams
				{ iteration: 2, inputTokens: 800, outputTokens: 400 }, // Search messages
				{ iteration: 3, inputTokens: 1200, outputTokens: 600 }, // Get details
				{ iteration: 4, inputTokens: 1500, outputTokens: 800 }, // Create summary
			].map((cost) => ({
				...cost,
				timestamp: new Date().toISOString(),
			}));

			const result = checkIterationBudget(costs, {
				maxTotalTokens: 10000,
				maxIterations: 15,
			});

			expect(result.withinBudget).toBe(true);
			expect(result.totalTokensUsed).toBe(6000);
			expect(result.remainingTokens).toBe(4000);
			expect(result.iterationsUsed).toBe(4);
		});

		it("should detect approaching budget limit", () => {
			const costs: IterationCost[] = [
				{
					iteration: 1,
					inputTokens: 4500,
					outputTokens: 4500,
					timestamp: new Date().toISOString(),
				},
			];

			const result = checkIterationBudget(costs, {
				maxTotalTokens: 10000,
				maxIterations: 15,
			});

			expect(result.withinBudget).toBe(true);
			expect(result.remainingTokens).toBe(1000); // Only 10% left
			expect(result.totalTokensUsed).toBe(9000);
		});

		it("should handle high-iteration low-token scenario", () => {
			// Many simple API calls
			const costs: IterationCost[] = Array.from(
				{ length: 12 },
				(_, i) => ({
					iteration: i + 1,
					toolName: `api_call_${i}`,
					inputTokens: 50,
					outputTokens: 30,
					timestamp: new Date().toISOString(),
				}),
			);

			const result = checkIterationBudget(costs, {
				maxTotalTokens: 10000,
				maxIterations: 15,
			});

			expect(result.withinBudget).toBe(true);
			expect(result.totalTokensUsed).toBe(960); // 80 * 12
			expect(result.iterationsUsed).toBe(12);
			expect(result.remainingIterations).toBe(3);
		});
	});

	describe("Edge Cases and Error Handling", () => {
		it("should handle costs with zero tokens", () => {
			const costs: IterationCost[] = [
				{
					iteration: 1,
					inputTokens: 0,
					outputTokens: 0,
					timestamp: new Date().toISOString(),
				},
			];

			const result = checkIterationBudget(costs, {
				maxTotalTokens: 10000,
				maxIterations: 15,
			});

			expect(result.withinBudget).toBe(true);
			expect(result.totalTokensUsed).toBe(0);
		});

		it("should handle very large token counts", () => {
			const costs: IterationCost[] = [
				{
					iteration: 1,
					inputTokens: 1000000,
					outputTokens: 500000,
					timestamp: new Date().toISOString(),
				},
			];

			const result = checkIterationBudget(costs, {
				maxTotalTokens: 100000,
				maxIterations: 15,
			});

			expect(result.withinBudget).toBe(false);
			expect(result.totalTokensUsed).toBe(1500000);
			expect(result.reason).toContain("Token budget exceeded");
		});

		it("should handle missing optional config parameters", () => {
			const costs: IterationCost[] = [
				{
					iteration: 1,
					inputTokens: 1000,
					outputTokens: 500,
					timestamp: new Date().toISOString(),
				},
			];

			const result = checkIterationBudget(costs);

			expect(result.withinBudget).toBe(true);
			expect(result.totalTokensUsed).toBe(1500);
		});
	});
});
