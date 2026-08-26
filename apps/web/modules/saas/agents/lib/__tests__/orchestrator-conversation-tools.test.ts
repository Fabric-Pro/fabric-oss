import { describe, expect, it } from "vitest";
import {
	getSelectedOrchestratorToolIds,
	mergeOrchestratorConversationMetadata,
} from "../orchestrator-conversation-tools";

describe("orchestrator-conversation-tools", () => {
	it("returns selected ids when present", () => {
		expect(
			getSelectedOrchestratorToolIds({
				mode: "orchestrator",
				selectedMcpConfigIds: ["cfg-1", "cfg-2"],
			}),
		).toEqual(["cfg-1", "cfg-2"]);
	});

	it("returns null when selection is absent", () => {
		expect(
			getSelectedOrchestratorToolIds({ mode: "orchestrator" }),
		).toBeNull();
	});

	it("merges selection into orchestrator metadata", () => {
		const result = mergeOrchestratorConversationMetadata({
			existing: { executions: [{ id: "exec-1" }], instanceId: "inst-1" },
			executionMode: "balanced",
			selectedMcpConfigIds: ["cfg-9"],
		});

		expect(result.mode).toBe("orchestrator");
		expect(result.instanceId).toBe("inst-1");
		expect(result.executions).toEqual([{ id: "exec-1" }]);
		expect(result.selectedMcpConfigIds).toEqual(["cfg-9"]);
	});

	it("removes stale selection when reverting to defaults", () => {
		const result = mergeOrchestratorConversationMetadata({
			existing: {
				mode: "orchestrator",
				selectedMcpConfigIds: ["cfg-9"],
			},
			executionMode: "lite",
		});

		expect(result).not.toHaveProperty("selectedMcpConfigIds");
	});
});
