/**
 * Agent Capabilities Tests
 *
 * Tests for agent capability analysis and delegation strategy determination.
 * Run with: pnpm --filter @repo/temporal test
 */

import { describe, expect, it } from "vitest";
import {
	agentHasCapability,
	determineDelegationStrategy,
	isAgentSuitableForTask,
} from "../src/activities/orchestrator/delegation/agent-capabilities";
import type { AgentCardCapabilities } from "../src/activities/orchestrator/types";

describe("agentHasCapability", () => {
	const fullCapabilities: AgentCardCapabilities = {
		autonomousExecution: true,
		taskDecomposition: true,
		codeExecution: true,
		browserAutomation: true,
		apiOrchestration: true,
		fileOperations: true,
		memoryEnabled: true,
		learningEnabled: true,
		multiTenancyAware: true,
		sandboxed: true,
		tags: ["generalist", "automation", "data-processing"],
		skills: [
			{
				id: "web-scraping",
				name: "Web Scraping",
				description: "Scrape web pages",
				tags: ["web", "scraping"],
			},
			{
				id: "data-analysis",
				name: "Data Analysis",
				description: "Analyze data sets",
				tags: ["data", "analysis"],
			},
		],
	};

	describe("direct capability flags", () => {
		it("should return true for code execution", () => {
			expect(agentHasCapability(fullCapabilities, "code")).toBe(true);
			expect(agentHasCapability(fullCapabilities, "code-execution")).toBe(
				true,
			);
		});

		it("should return true for browser automation", () => {
			expect(agentHasCapability(fullCapabilities, "browser")).toBe(true);
			expect(
				agentHasCapability(fullCapabilities, "browser-automation"),
			).toBe(true);
		});

		it("should return true for API orchestration", () => {
			expect(agentHasCapability(fullCapabilities, "api")).toBe(true);
			expect(
				agentHasCapability(fullCapabilities, "api-orchestration"),
			).toBe(true);
		});

		it("should return true for file operations", () => {
			expect(agentHasCapability(fullCapabilities, "file")).toBe(true);
			expect(
				agentHasCapability(fullCapabilities, "file-operations"),
			).toBe(true);
		});

		it("should return true for autonomous execution", () => {
			expect(agentHasCapability(fullCapabilities, "autonomous")).toBe(
				true,
			);
		});

		it("should return true for task decomposition", () => {
			expect(
				agentHasCapability(fullCapabilities, "task-decomposition"),
			).toBe(true);
			expect(agentHasCapability(fullCapabilities, "planning")).toBe(true);
		});
	});

	describe("tag matching", () => {
		it("should match capabilities from tags", () => {
			expect(agentHasCapability(fullCapabilities, "generalist")).toBe(
				true,
			);
			expect(agentHasCapability(fullCapabilities, "automation")).toBe(
				true,
			);
		});

		it("should be case-insensitive for tags", () => {
			expect(agentHasCapability(fullCapabilities, "GENERALIST")).toBe(
				true,
			);
			expect(agentHasCapability(fullCapabilities, "Automation")).toBe(
				true,
			);
		});
	});

	describe("skill matching", () => {
		it("should match capabilities from skill IDs", () => {
			expect(agentHasCapability(fullCapabilities, "web-scraping")).toBe(
				true,
			);
			expect(agentHasCapability(fullCapabilities, "data-analysis")).toBe(
				true,
			);
		});

		it("should match capabilities from skill names", () => {
			expect(agentHasCapability(fullCapabilities, "scraping")).toBe(true);
			expect(agentHasCapability(fullCapabilities, "analysis")).toBe(true);
		});

		it("should match capabilities from skill tags", () => {
			expect(agentHasCapability(fullCapabilities, "web")).toBe(true);
			expect(agentHasCapability(fullCapabilities, "data")).toBe(true);
		});
	});

	describe("missing capabilities", () => {
		const limitedCapabilities: AgentCardCapabilities = {
			autonomousExecution: false,
			taskDecomposition: false,
			codeExecution: false,
			browserAutomation: false,
		};

		it("should return false for disabled capabilities", () => {
			expect(agentHasCapability(limitedCapabilities, "code")).toBe(false);
			expect(agentHasCapability(limitedCapabilities, "browser")).toBe(
				false,
			);
		});

		it("should return false for undefined capabilities", () => {
			expect(agentHasCapability(undefined, "code")).toBe(false);
		});

		it("should return false for non-existent capability", () => {
			expect(agentHasCapability(fullCapabilities, "teleportation")).toBe(
				false,
			);
		});
	});
});

describe("isAgentSuitableForTask", () => {
	const generalistCapabilities: AgentCardCapabilities = {
		autonomousExecution: true,
		taskDecomposition: true,
		codeExecution: true,
		browserAutomation: true,
		apiOrchestration: true,
		maxAutonomyLevel: "task",
	};

	const browserOnlyCapabilities: AgentCardCapabilities = {
		autonomousExecution: false,
		taskDecomposition: false,
		browserAutomation: true,
	};

	const codeOnlyCapabilities: AgentCardCapabilities = {
		autonomousExecution: false,
		taskDecomposition: false,
		codeExecution: true,
	};

	describe("browser tasks", () => {
		it("should rate browser agent high for browser tasks", () => {
			const result = isAgentSuitableForTask(
				browserOnlyCapabilities,
				"Scrape the product listings from this web page",
			);
			expect(result.suitable).toBe(true);
			expect(result.confidence).toBeGreaterThanOrEqual(50);
			expect(result.reasoning).toContain("browser automation");
		});

		it("should rate code-only agent low for browser tasks", () => {
			const result = isAgentSuitableForTask(
				codeOnlyCapabilities,
				"Navigate to the website and click the login button",
			);
			expect(result.confidence).toBeLessThan(50);
			expect(result.reasoning).toContain("Missing browser automation");
		});
	});

	describe("code execution tasks", () => {
		it("should rate code agent high for code tasks", () => {
			const result = isAgentSuitableForTask(
				codeOnlyCapabilities,
				"Execute this Python script to process the data",
			);
			expect(result.suitable).toBe(true);
			expect(result.confidence).toBeGreaterThanOrEqual(50);
			expect(result.reasoning).toContain("code execution");
		});

		it("should rate browser-only agent low for code tasks", () => {
			const result = isAgentSuitableForTask(
				browserOnlyCapabilities,
				"Run the following JavaScript code and return the result",
			);
			expect(result.confidence).toBeLessThan(50);
		});
	});

	describe("complex tasks", () => {
		it("should rate generalist high for complex planning tasks", () => {
			const result = isAgentSuitableForTask(
				generalistCapabilities,
				"Research the competitors, analyze their pricing strategies, and create a comprehensive report with recommendations",
			);
			expect(result.suitable).toBe(true);
			expect(result.confidence).toBeGreaterThanOrEqual(70);
			expect(result.reasoning).toContain("task decomposition");
		});

		it("should give bonus for autonomous execution on complex tasks", () => {
			const result = isAgentSuitableForTask(
				generalistCapabilities,
				"Plan and implement a full data pipeline",
			);
			expect(result.reasoning).toContain("autonomously");
		});
	});

	describe("undefined capabilities", () => {
		it("should return not suitable for undefined capabilities", () => {
			const result = isAgentSuitableForTask(
				undefined,
				"Do something complex",
			);
			expect(result.suitable).toBe(false);
			expect(result.confidence).toBe(0);
			expect(result.reasoning).toContain("No capability information");
		});
	});
});

describe("determineDelegationStrategy", () => {
	describe("generalist agents", () => {
		it("should use complete-task delegation for task-level generalist", () => {
			const capabilities: AgentCardCapabilities = {
				autonomousExecution: true,
				taskDecomposition: true,
				maxAutonomyLevel: "task",
			};
			const result = determineDelegationStrategy(
				capabilities,
				"Build a complete application",
			);
			expect(result.delegationMode).toBe("complete-task");
			expect(result.shouldDecompose).toBe(false);
			expect(result.reasoning).toContain("Generalist agent");
		});

		it("should use complete-task delegation for session-level generalist", () => {
			const capabilities: AgentCardCapabilities = {
				autonomousExecution: true,
				taskDecomposition: true,
				maxAutonomyLevel: "session",
			};
			const result = determineDelegationStrategy(
				capabilities,
				"Handle this user session",
			);
			expect(result.delegationMode).toBe("complete-task");
			expect(result.shouldDecompose).toBe(false);
		});
	});

	describe("limited autonomy agents", () => {
		it("should use single-step for autonomous but limited autonomy", () => {
			const capabilities: AgentCardCapabilities = {
				autonomousExecution: true,
				taskDecomposition: false,
				maxAutonomyLevel: "step",
			};
			const result = determineDelegationStrategy(
				capabilities,
				"Process this data",
			);
			expect(result.delegationMode).toBe("single-step");
			expect(result.shouldDecompose).toBe(true);
			expect(result.reasoning).toContain("limited autonomy");
		});

		it("should decompose for agent with task decomposition but no autonomy level", () => {
			const capabilities: AgentCardCapabilities = {
				autonomousExecution: true,
				taskDecomposition: true,
				// maxAutonomyLevel not set - defaults to step
			};
			const result = determineDelegationStrategy(
				capabilities,
				"Complex task",
			);
			expect(result.delegationMode).toBe("single-step");
			expect(result.shouldDecompose).toBe(true);
		});
	});

	describe("simple agents", () => {
		it("should use single-step for non-autonomous agents", () => {
			const capabilities: AgentCardCapabilities = {
				autonomousExecution: false,
				taskDecomposition: false,
			};
			const result = determineDelegationStrategy(
				capabilities,
				"Generate a summary",
			);
			expect(result.delegationMode).toBe("single-step");
			expect(result.shouldDecompose).toBe(true);
			expect(result.reasoning).toContain("Simple agent");
		});
	});

	describe("undefined capabilities", () => {
		it("should use conservative single-step for unknown agents", () => {
			const result = determineDelegationStrategy(
				undefined,
				"Unknown task",
			);
			expect(result.delegationMode).toBe("single-step");
			expect(result.shouldDecompose).toBe(true);
			expect(result.reasoning).toContain("Unknown agent");
		});
	});
});
