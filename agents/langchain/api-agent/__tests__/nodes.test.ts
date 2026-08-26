/**
 * Unit tests for API Agent Nodes Module
 */

import { describe, expect, it } from "vitest";
import { analyzeTaskNode, executeToolNode, formatResponseNode } from "../nodes";

describe("Nodes Module", () => {
	describe("Node Exports", () => {
		it("should export analyzeTaskNode function", () => {
			expect(typeof analyzeTaskNode).toBe("function");
		});

		it("should export executeToolNode function", () => {
			expect(typeof executeToolNode).toBe("function");
		});

		it("should export formatResponseNode function", () => {
			expect(typeof formatResponseNode).toBe("function");
		});
	});

	describe("Node Functions", () => {
		it("analyzeTaskNode should be async", () => {
			expect(analyzeTaskNode.constructor.name).toBe("AsyncFunction");
		});

		it("executeToolNode should be async", () => {
			expect(executeToolNode.constructor.name).toBe("AsyncFunction");
		});

		it("formatResponseNode should be async", () => {
			expect(formatResponseNode.constructor.name).toBe("AsyncFunction");
		});
	});
});
