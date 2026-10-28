import { describe, expect, it } from "vitest";
import {
	FABRIC_AGENT_CONNECTIONS,
	getExecutionProviderDescription,
	getExecutionProviderLabel,
	getExecutionProviderPlatformLabel,
	getFabricAgentConnectionLabel,
	getImplementationRecommendation,
} from "../implementation-session-labels";

describe("implementation-session recommendation helper", () => {
	it("labels BACKGROUND_AGENTS as Fabric Agents with isolated worktree description", () => {
		expect(getExecutionProviderLabel("BACKGROUND_AGENTS")).toBe(
			"Fabric Agents",
		);
		expect(getExecutionProviderPlatformLabel("BACKGROUND_AGENTS")).toBe(
			"Fabric Agents",
		);
		expect(getExecutionProviderDescription("BACKGROUND_AGENTS")).toBe(
			"Runs in an isolated git worktree on Fabric Agents with live desktop & Web UI session tracking.",
		);
	});

	it("exposes supported Fabric Agents backend connections and resolves shorthand aliases", () => {
		const values = FABRIC_AGENT_CONNECTIONS.map((c) => c.value);
		expect(values).toEqual([
			"default",
			"claude-max",
			"codex",
			"cursor-cli",
			"antigravity-cli",
			"droid-cli",
			"grok-cli",
			"kimi-cli",
		]);
		expect(getFabricAgentConnectionLabel("claude-max")).toBe("Claude Max");
		expect(getFabricAgentConnectionLabel("droid-cli")).toBe(
			"Factory Droid",
		);
		expect(getFabricAgentConnectionLabel("droid")).toBe("Factory Droid");
		expect(getFabricAgentConnectionLabel("chatgpt-plus")).toBe("Codex");
		expect(getFabricAgentConnectionLabel("default")).toBeNull();
	});

	it("defaults to Fabric Agents even when repository context exists", () => {
		const recommendation = getImplementationRecommendation({
			hasRepositoryContext: true,
			openTaskCount: 3,
			focusedTaskId: "task_1",
			implementationDefaultChannel: "LOCAL_AGENTS",
			implementationDefaultProvider: "KANBAN_LOCAL",
		});

		expect(recommendation.channel).toBe("BACKGROUND_AGENTS");
		expect(recommendation.provider).toBe("BACKGROUND_AGENTS");
		expect(recommendation.reason).toContain(
			"Fabric Agents is the recommended path for direct implementation",
		);
	});

	it("falls back to background agents when repo context is missing", () => {
		const recommendation = getImplementationRecommendation({
			hasRepositoryContext: false,
			openTaskCount: 2,
		});

		expect(recommendation.channel).toBe("BACKGROUND_AGENTS");
		expect(recommendation.provider).toBe("BACKGROUND_AGENTS");
		expect(recommendation.reason).toContain(
			"Direct implementation needs a connected repository",
		);
	});
});
