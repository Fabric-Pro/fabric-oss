import { isRetiredSystemAgent } from "@repo/agent-types";
import { describe, expect, it } from "vitest";
import { ORCHESTRATOR_SYSTEM_AGENT_IDS } from "../capability-system-agents";

describe("run-agent capability system-agent defaults", () => {
	it("never enables retired system agents while preserving active execution capabilities", () => {
		expect(
			ORCHESTRATOR_SYSTEM_AGENT_IDS.some((agentId) =>
				isRetiredSystemAgent({ agentId, scope: "SYSTEM" }),
			),
		).toBe(false);
		expect(ORCHESTRATOR_SYSTEM_AGENT_IDS).toEqual(
			expect.arrayContaining([
				"data_analyst",
				"task_planner",
				"document_generator",
				"code_executor",
			]),
		);
		expect(new Set(ORCHESTRATOR_SYSTEM_AGENT_IDS).size).toBe(
			ORCHESTRATOR_SYSTEM_AGENT_IDS.length,
		);
	});
});
