/**
 * How one picked agent's own scope merges with the chat's shared fields
 * (`multiAgentRequestOverrides`, Nexus's rules, now shared with the agent
 * runtime's multi-agent turns):
 *
 *   - a model pick has no scope of its own: it takes the chat's MCP
 *     servers, Fabric tools, integrations, knowledge bases and project;
 *   - an agent's own MCP servers win, and make it focused: no Fabric tools
 *     beyond those the chat enables, plus workspace retrieval when it has
 *     knowledge bases;
 *   - an agent's own integrations win over the chat's; its bound project
 *     applies only when the chat names none, and an explicit null disables it;
 *   - the prompt is the agent's instructions, else one built from its name.
 */
import { describe, expect, it } from "vitest";
import { multiAgentRequestOverrides } from "../multi-agent-request";

const shared = {
	enabledMcpConfigIds: ["mcp-chat"],
	enabledFabricToolIds: ["web_search"],
	enabledIntegrationIds: ["integration-chat"],
	workspaceIds: ["workspace-chat"],
	projectId: "project-chat",
};

describe("multiAgentRequestOverrides", () => {
	it("gives a model pick the chat's whole scope", () => {
		expect(
			multiAgentRequestOverrides(
				{
					agentId: "model:alpha",
					name: "Alpha",
					modelOverride: "alpha",
				},
				shared,
			),
		).toEqual({
			systemPrompt: expect.stringContaining(
				"You are Alpha, an AI assistant.",
			),
			modelOverride: "alpha",
			instanceId: undefined,
			enabledMcpConfigIds: ["mcp-chat"],
			enabledFabricToolIds: ["web_search"],
			enabledIntegrationIds: ["integration-chat"],
			workspaceIds: ["workspace-chat"],
			projectId: "project-chat",
		});
	});

	it("lets a focused agent's own servers and integrations win", () => {
		const overrides = multiAgentRequestOverrides(
			{
				agentId: "template-instance:one",
				name: "Researcher",
				instructions: "Research carefully.",
				enabledMcpConfigIds: ["mcp-agent"],
				enabledIntegrationIds: ["integration-agent"],
				workspaceIds: ["workspace-agent"],
				instanceId: "one",
				boundProjectId: "project-agent",
			},
			{ ...shared, projectId: undefined },
		);

		expect(overrides).toMatchObject({
			systemPrompt: "Research carefully.",
			instanceId: "one",
			enabledMcpConfigIds: ["mcp-agent"],
			enabledFabricToolIds: [
				"web_search",
				"workspace_rag_query",
				"workspace_rag_summarize",
			],
			enabledIntegrationIds: ["integration-agent"],
			workspaceIds: ["workspace-agent"],
			projectId: "project-agent",
		});
	});

	it("gives a focused agent no Fabric tools the chat does not enable", () => {
		expect(
			multiAgentRequestOverrides({
				agentId: "template-instance:two",
				name: "Writer",
				description: "Writes release notes.",
				enabledMcpConfigIds: ["mcp-agent"],
			}),
		).toMatchObject({
			systemPrompt: expect.stringContaining(
				"You are Writer. Writes release notes.",
			),
			enabledFabricToolIds: [],
			enabledIntegrationIds: null,
			workspaceIds: [],
		});
	});

	it("lets an explicit project, or none, replace the agent's bound one", () => {
		const agent = {
			agentId: "template-instance:three",
			name: "Planner",
			boundProjectId: "project-agent",
		};
		expect(
			multiAgentRequestOverrides(agent, { projectId: "project-chat" })
				.projectId,
		).toBe("project-chat");
		expect(
			multiAgentRequestOverrides(agent, { projectId: null }).projectId,
		).toBeNull();
	});
});
