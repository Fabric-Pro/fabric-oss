/**
 * Unit tests for Project Document Generator Nodes Module
 */

import { describe, expect, it } from "vitest";
import { chatNode } from "../nodes";

describe("Nodes Module", () => {
	describe("Node Exports", () => {
		it("should export chatNode function", () => {
			expect(typeof chatNode).toBe("function");
		});
	});

	describe("Node Functions", () => {
		it("chatNode should be async", () => {
			expect(chatNode.constructor.name).toBe("AsyncFunction");
		});
	});
});
