import { describe, expect, it } from "vitest";
import {
	buildFabricDesktopNewSessionUrl,
	buildRemoteAgentServerDelegationUrl,
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
			"droid-cli",
			"grok-cli",
			"kimi-cli",
			"antigravity-cli",
			"cursor-cli",
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

	it("builds Fabric Desktop deep links and Remote Fabric Agents Server delegation URLs with subscription harness and fallback policy", () => {
		const desktopUrl = buildFabricDesktopNewSessionUrl({
			projectName: "Payments V2",
			projectId: "proj_123",
			prompt: "Implement OAuth callback",
			send: true,
		});
		expect(desktopUrl).toContain("fabricagents://action/new-chat?");
		expect(desktopUrl).toContain("name=Payments+V2");

		const remoteUrl = buildRemoteAgentServerDelegationUrl({
			serverUrl: "https://agents.example.com",
			projectName: "Payments V2",
			projectId: "proj_123",
			connection: "claude-max",
			model: "claude-opus-4-6",
			fallbackPolicy: "subscription_harnesses",
			origin: "https://app.example.com",
			prompt: "Implement OAuth callback",
		});
		expect(remoteUrl).toContain("https://agents.example.com/?");
		expect(remoteUrl).toContain("project=Payments+V2");
		expect(remoteUrl).toContain("projectId=proj_123");
		expect(remoteUrl).toContain("harness=claude-max");
		expect(remoteUrl).toContain("model=claude-opus-4-6");
		expect(remoteUrl).toContain("fallback=subscription_harnesses");
		expect(remoteUrl).toContain(
			"mcpGateway=https%3A%2F%2Fapp.example.com%2Fapi%2Fmcp-gateway%2Fprojects%2Fproj_123",
		);
	});
});
