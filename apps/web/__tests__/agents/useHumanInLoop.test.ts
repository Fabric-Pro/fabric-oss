/**
 * Unit tests for useHumanInLoop hook
 */
import { describe, expect, it, vi } from "vitest";

// Mock CopilotKit
vi.mock("@copilotkit/react-core", () => ({
	useCopilotAction: vi.fn(),
}));

// Mock uuid
vi.mock("uuid", () => ({
	v4: () => "test-uuid-123",
}));

import type {
	HITLOption,
	HITLRequest,
	HITLRequestType,
	HITLResponse,
} from "@saas/agents/hooks/useHumanInLoop";

describe("useHumanInLoop Types", () => {
	describe("HITLRequest", () => {
		it("should have correct structure for approval request", () => {
			const request: HITLRequest = {
				requestId: "req-001",
				type: "approval",
				prompt: "Do you approve this action?",
				title: "Approval Required",
				timeout: 60000,
				createdAt: Date.now(),
			};

			expect(request.type).toBe("approval");
			expect(request.prompt).toBeDefined();
			expect(request.requestId).toBeDefined();
		});

		it("should have correct structure for input request", () => {
			const request: HITLRequest = {
				requestId: "req-002",
				type: "input",
				prompt: "Please enter your name",
				defaultValue: "John",
				required: true,
				createdAt: Date.now(),
			};

			expect(request.type).toBe("input");
			expect(request.defaultValue).toBe("John");
		});

		it("should have correct structure for choice request", () => {
			const options: HITLOption[] = [
				{
					value: "opt1",
					label: "Option 1",
					description: "First option",
				},
				{ value: "opt2", label: "Option 2" },
			];

			const request: HITLRequest = {
				requestId: "req-003",
				type: "choice",
				prompt: "Select an option",
				options,
				createdAt: Date.now(),
			};

			expect(request.type).toBe("choice");
			expect(request.options).toHaveLength(2);
			expect(request.options?.[0].description).toBe("First option");
		});
	});

	describe("HITLResponse", () => {
		it("should have correct structure for approval response", () => {
			const response: HITLResponse = {
				requestId: "req-001",
				approved: true,
				respondedAt: Date.now(),
			};

			expect(response.approved).toBe(true);
			expect(response.value).toBeUndefined();
		});

		it("should have correct structure for input response", () => {
			const response: HITLResponse = {
				requestId: "req-002",
				approved: true,
				value: "User input text",
				respondedAt: Date.now(),
			};

			expect(response.approved).toBe(true);
			expect(response.value).toBe("User input text");
		});

		it("should have correct structure for choice response", () => {
			const response: HITLResponse = {
				requestId: "req-003",
				approved: true,
				value: "opt1",
				respondedAt: Date.now(),
			};

			expect(response.value).toBe("opt1");
		});

		it("should handle rejection", () => {
			const response: HITLResponse = {
				requestId: "req-001",
				approved: false,
				respondedAt: Date.now(),
			};

			expect(response.approved).toBe(false);
		});
	});

	describe("HITLRequestType", () => {
		it("should support all request types", () => {
			const types: HITLRequestType[] = ["approval", "input", "choice"];

			types.forEach((type) => {
				const request: HITLRequest = {
					requestId: `req-${type}`,
					type,
					prompt: `Test ${type}`,
					createdAt: Date.now(),
				};
				expect(request.type).toBe(type);
			});
		});
	});

	describe("HITLOption", () => {
		it("should support minimal option", () => {
			const option: HITLOption = {
				value: "val",
				label: "Label",
			};

			expect(option.value).toBe("val");
			expect(option.label).toBe("Label");
			expect(option.description).toBeUndefined();
		});

		it("should support full option", () => {
			const option: HITLOption = {
				value: "val",
				label: "Label",
				description: "Description",
				icon: "check",
			};

			expect(option.description).toBe("Description");
			expect(option.icon).toBe("check");
		});
	});
});
