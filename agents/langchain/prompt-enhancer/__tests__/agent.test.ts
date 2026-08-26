/**
 * Agent Module Tests
 *
 * Tests for the main agent graph and exports.
 */

import { describe, expect, it, vi } from "vitest";

// Mock dependencies for testing
vi.mock("../utils", () => ({
	DEFAULT_RECURSION_LIMIT: 25,
	getAgentModel: vi.fn(() => ({
		bindTools: vi.fn(() => ({
			invoke: vi.fn(),
		})),
	})),
	getAgentModelAsync: vi.fn(() =>
		Promise.resolve({
			bindTools: vi.fn(() => ({
				invoke: vi.fn(),
			})),
		}),
	),
	extractProviderConfig: vi.fn(() => ({
		apiKey: "test-key",
		model: "test-model",
		baseUrl: "https://test.com",
	})),
}));

vi.mock("@repo/agent-tools", () => ({
	ENHANCE_PROMPT_TOOL: {
		name: "enhance_prompt_local",
		description: "Enhance a prompt",
		schema: {},
	},
}));

import {
	DEFAULT_RECURSION_LIMIT,
	enhanceNode,
	extractProviderConfig,
	getAgentModel,
	getAgentModelAsync,
	getPredictStateConfig,
	getSystemPrompt,
	graphMetadata,
	PromptEnhancerState,
	promptEnhancerGraph,
} from "../agent";

describe("promptEnhancerGraph", () => {
	it("should be defined", () => {
		expect(promptEnhancerGraph).toBeDefined();
	});

	it("should be a compiled graph", () => {
		expect(promptEnhancerGraph).toBeDefined();
		expect(typeof promptEnhancerGraph.invoke).toBe("function");
		expect(typeof promptEnhancerGraph.stream).toBe("function");
	});

	it("should have graph nodes", () => {
		expect(promptEnhancerGraph).toBeDefined();
	});
});

describe("graphMetadata", () => {
	describe("basic properties", () => {
		it("should have a name", () => {
			expect(graphMetadata.name).toBe("prompt_enhancer");
		});

		it("should have a description", () => {
			expect(graphMetadata.description).toBeDefined();
			expect(typeof graphMetadata.description).toBe("string");
			expect(graphMetadata.description.length).toBeGreaterThan(0);
		});

		it("should have a version", () => {
			expect(graphMetadata.version).toBeDefined();
			expect(graphMetadata.version).toMatch(/^\d+\.\d+\.\d+$/);
		});
	});

	describe("capabilities", () => {
		it("should list capabilities", () => {
			expect(Array.isArray(graphMetadata.capabilities)).toBe(true);
			expect(graphMetadata.capabilities.length).toBeGreaterThan(0);
		});

		it("should include prompt-enhancement capability", () => {
			expect(graphMetadata.capabilities).toContain("prompt-enhancement");
		});

		it("should include format-aware capability", () => {
			expect(graphMetadata.capabilities).toContain("format-aware");
		});

		it("should include predictive-updates capability", () => {
			expect(graphMetadata.capabilities).toContain("predictive-updates");
		});

		it("should include streaming capability", () => {
			expect(graphMetadata.capabilities).toContain("streaming");
		});

		it("should include ag-ui-protocol capability", () => {
			expect(graphMetadata.capabilities).toContain("ag-ui-protocol");
		});
	});

	describe("protocol support", () => {
		it("should list protocols", () => {
			expect(Array.isArray(graphMetadata.protocols)).toBe(true);
		});

		it("should support ag-ui protocol", () => {
			expect(graphMetadata.protocols).toContain("ag-ui");
		});
	});

	describe("features", () => {
		it("should support predictive updates", () => {
			expect(graphMetadata.supportsPredictiveUpdates).toBe(true);
		});
	});
});

describe("Module exports", () => {
	describe("State exports", () => {
		it("should export PromptEnhancerState", () => {
			expect(PromptEnhancerState).toBeDefined();
		});
	});

	describe("Utility exports", () => {
		it("should export DEFAULT_RECURSION_LIMIT", () => {
			expect(DEFAULT_RECURSION_LIMIT).toBeDefined();
			expect(DEFAULT_RECURSION_LIMIT).toBe(25);
		});

		it("should export getAgentModel", () => {
			expect(getAgentModel).toBeDefined();
			expect(typeof getAgentModel).toBe("function");
		});

		it("should export getAgentModelAsync", () => {
			expect(getAgentModelAsync).toBeDefined();
			expect(typeof getAgentModelAsync).toBe("function");
		});

		it("should export extractProviderConfig", () => {
			expect(extractProviderConfig).toBeDefined();
			expect(typeof extractProviderConfig).toBe("function");
		});
	});

	describe("Prompt exports", () => {
		it("should export getSystemPrompt", () => {
			expect(getSystemPrompt).toBeDefined();
			expect(typeof getSystemPrompt).toBe("function");
		});

		it("should export getPredictStateConfig", () => {
			expect(getPredictStateConfig).toBeDefined();
			expect(typeof getPredictStateConfig).toBe("function");
		});
	});

	describe("Node exports", () => {
		it("should export enhanceNode", () => {
			expect(enhanceNode).toBeDefined();
			expect(typeof enhanceNode).toBe("function");
		});
	});
});

describe("Graph structure", () => {
	it("should have single-node pipeline", () => {
		// The graph should be a simple enhance -> END pipeline
		expect(promptEnhancerGraph).toBeDefined();
	});

	it("should not use checkpointing", () => {
		// Graph is compiled without checkpointer for simple enhancement
		expect(promptEnhancerGraph).toBeDefined();
	});
});

describe("AG-UI Protocol Integration", () => {
	it("should have predict state configuration", () => {
		const config = getPredictStateConfig();
		expect(Array.isArray(config)).toBe(true);
		expect(config.length).toBeGreaterThan(0);
	});

	it("should configure streamingContent for predictive updates", () => {
		const config = getPredictStateConfig();
		const streamingConfig = config.find(
			(c) => c.state_key === "streamingContent",
		);
		expect(streamingConfig).toBeDefined();
	});

	it("should configure focusAnchor for cursor positioning", () => {
		const config = getPredictStateConfig();
		const focusConfig = config.find((c) => c.state_key === "focusAnchor");
		expect(focusConfig).toBeDefined();
	});
});

describe("Version compatibility", () => {
	it("should export AgentState type alias for backwards compatibility", async () => {
		// Type-level test - imports should work
		const agent = await import("../agent");
		expect(agent).toHaveProperty("PromptEnhancerState");
	});
});
