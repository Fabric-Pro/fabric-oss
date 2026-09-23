import { describe, expect, it } from "vitest";
import {
	buildAgentInstanceChatHref,
	buildFabricAgentHref,
	instanceIdFromLegacyNexusAgentParam,
	unifiedChatHrefFromNexusQuery,
} from "../fabric-agent-links";

describe("buildFabricAgentHref", () => {
	it("builds a base Fabric Agent link without context", () => {
		expect(buildFabricAgentHref({ basePath: "/app" })).toBe(
			"/app/agents/fabric-ai",
		);
	});

	it("includes contextual params and a suggested prompt", () => {
		const href = buildFabricAgentHref({
			basePath: "/app/acme",
			projectId: "project_1",
			projectName: "Fabric",
			storyId: "story_1",
			storyIdentifier: "US-12",
			storyTitle: "Launch task-first workflows",
			taskId: "task_9",
			taskIdentifier: "TASK-9",
			taskTitle: "Wire contextual links",
			prompt: "Summarize this task and propose next steps.",
		});

		expect(href).toContain("/app/acme/agents/fabric-ai?");
		expect(href).toContain("projectId=project_1");
		expect(href).toContain("storyIdentifier=US-12");
		expect(href).toContain("taskIdentifier=TASK-9");
		expect(href).toContain(
			"prompt=Summarize+this+task+and+propose+next+steps.",
		);
	});
});

describe("buildAgentInstanceChatHref (#2040)", () => {
	const instance = {
		id: "inst_1",
		name: "Release notes",
		description: null,
	};

	it("opens the agent on the unified chat as an instance-backed chat", () => {
		expect(
			buildAgentInstanceChatHref({
				basePath: "/app/acme",
				instance,
				unifiedAgentInterface: true,
			}),
		).toBe("/app/acme/agents/fabric-ai?mode=agent&instanceId=inst_1");
	});

	it("keeps the legacy Nexus link while the flag is off", () => {
		const href = buildAgentInstanceChatHref({
			basePath: "/app/acme",
			instance,
			unifiedAgentInterface: false,
		});
		expect(href.startsWith("/app/acme/nexus?agent=")).toBe(true);
		const agent = decodeURIComponent(href.split("?agent=")[1] ?? "");
		expect(JSON.parse(agent)).toEqual({
			agentId: "template-instance:inst_1",
			name: "Release notes",
			description: "",
		});
	});
});

describe("instanceIdFromLegacyNexusAgentParam (#2040)", () => {
	it("reads the instance id from a template-instance agent", () => {
		expect(
			instanceIdFromLegacyNexusAgentParam(
				JSON.stringify({ agentId: "template-instance:inst_1" }),
			),
		).toBe("inst_1");
	});

	it("drops anything that names no instance", () => {
		expect(instanceIdFromLegacyNexusAgentParam(undefined)).toBeNull();
		expect(instanceIdFromLegacyNexusAgentParam("{broken")).toBeNull();
		expect(
			instanceIdFromLegacyNexusAgentParam(
				JSON.stringify({ agentId: "model:gpt" }),
			),
		).toBeNull();
		expect(
			instanceIdFromLegacyNexusAgentParam(
				JSON.stringify({ agentId: "template-instance:" }),
			),
		).toBeNull();
	});
});

describe("unifiedChatHrefFromNexusQuery (#2040)", () => {
	it("translates the agent and drops the Nexus conversation id", () => {
		expect(
			unifiedChatHrefFromNexusQuery("/app/acme", {
				agent: JSON.stringify({ agentId: "template-instance:inst_1" }),
				c: "aichat_1",
			}),
		).toBe("/app/acme/agents/fabric-ai?mode=agent&instanceId=inst_1");
	});

	it("lands on the plain chat otherwise", () => {
		expect(unifiedChatHrefFromNexusQuery("/app/acme", { c: "x" })).toBe(
			"/app/acme/agents/fabric-ai",
		);
	});
});
