/**
 * Unit tests for Task Planner Nodes Module
 */

import { describe, expect, it } from "vitest";
import {
	analyzeNode,
	assessRisksNode,
	buildDependenciesNode,
	generateDocumentNode,
	planExecutionNode,
} from "../nodes";

describe("Nodes Module", () => {
	describe("Node Exports", () => {
		it("should export analyzeNode function", () => {
			expect(typeof analyzeNode).toBe("function");
		});

		it("should export assessRisksNode function", () => {
			expect(typeof assessRisksNode).toBe("function");
		});

		it("should export buildDependenciesNode function", () => {
			expect(typeof buildDependenciesNode).toBe("function");
		});

		it("should export planExecutionNode function", () => {
			expect(typeof planExecutionNode).toBe("function");
		});

		it("should export generateDocumentNode function", () => {
			expect(typeof generateDocumentNode).toBe("function");
		});
	});

	describe("Node Functions", () => {
		it("analyzeNode should be async", () => {
			// Check if it returns a promise-like object
			expect(analyzeNode.constructor.name).toBe("AsyncFunction");
		});

		it("assessRisksNode should be async", () => {
			expect(assessRisksNode.constructor.name).toBe("AsyncFunction");
		});

		it("buildDependenciesNode should be async", () => {
			expect(buildDependenciesNode.constructor.name).toBe(
				"AsyncFunction",
			);
		});

		it("planExecutionNode should be async", () => {
			expect(planExecutionNode.constructor.name).toBe("AsyncFunction");
		});

		it("generateDocumentNode should be async", () => {
			expect(generateDocumentNode.constructor.name).toBe("AsyncFunction");
		});
	});
});
