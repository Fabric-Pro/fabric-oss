/**
 * Unit tests for Story Breakdown Nodes Module
 */

import { describe, expect, it } from "vitest";
import { breakdownNode } from "../nodes";

describe("Nodes Module", () => {
	describe("Node Exports", () => {
		it("should export breakdownNode function", () => {
			expect(typeof breakdownNode).toBe("function");
		});
	});

	describe("Node Functions", () => {
		it("breakdownNode should be async", () => {
			expect(breakdownNode.constructor.name).toBe("AsyncFunction");
		});
	});
});
