/**
 * An agent configured with a Microsoft Graph integration gets the Microsoft
 * Teams tools only when the CALLER has an active Teams connection. In an
 * organization each member's connection is a personal OAuth grant, so a
 * teammate's connection must not light up the tools for a member who never
 * connected (or who disconnected).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	connectionRow,
	type FakeWorkflowIntegrationRow,
} from "../../../__tests__/helpers/workflow-integration-fake";
import { executeAgentTurn } from "../agent-execution-core/agent-executor";
import { withAgentToolRuntime } from "../shared/agent-tool-runtime";

const state = vi.hoisted(() => ({
	rows: [] as FakeWorkflowIntegrationRow[],
}));

vi.mock("@repo/database", async (original) => {
	const actual = await original<typeof import("@repo/database")>();
	const { createWorkflowIntegrationFake } = await import(
		"../../../__tests__/helpers/workflow-integration-fake"
	);
	return {
		...actual,
		loadProjectDatabricksKnowledgeBinding: async () => null,
		db: new Proxy(actual.db, {
			get: (target, property, receiver) =>
				property === "workflowIntegration"
					? createWorkflowIntegrationFake(state.rows)
					: Reflect.get(target, property, receiver),
		}),
	};
});

vi.mock("@repo/mcp-registry", async (original) => ({
	...(await original<typeof import("@repo/mcp-registry")>()),
	MICROSOFT_TEAMS_ACCOUNT: {
		id: "teams",
		mcps: [
			{
				id: "teams-mcp",
				name: "Teams",
				serverName: "Teams",
				tools: [
					{ name: "list_chats", description: "", inputSchema: {} },
				],
			},
		],
	},
}));

const TEAMS_TOOL = "Teams__list_chats";

async function loadedToolNames(): Promise<string[]> {
	let names: string[] = [];
	await withAgentToolRuntime(
		{
			invoke: vi.fn(),
			prepared: async (tools) => {
				names = Object.keys(tools);
				return "Prepared";
			},
		},
		() =>
			executeAgentTurn({
				systemPrompt: "Agent",
				userMessage: "List my chats",
				userId: "user-2",
				organizationId: "org-example",
				integrationConfigurations: [
					{
						integrationId: "configured-integration",
						integrationType: "MICROSOFT_GRAPH",
					},
				],
			}),
	);
	return names;
}

// The teammate's row is seeded FIRST, so a lookup that drops userId in the
// organization arm picks it up.
const teammateTeams = connectionRow({
	id: "wi-ms-teammate",
	userId: "user-1",
	provider: "MICROSOFT_GRAPH",
});
const callerTeams = connectionRow({
	id: "wi-ms-caller",
	userId: "user-2",
	provider: "MICROSOFT_GRAPH",
});

beforeEach(() => {
	state.rows = [];
});

describe("agent executor Microsoft Teams tools: connection owner", () => {
	it("org context: does not load Teams tools from a teammate's connection", async () => {
		state.rows = [teammateTeams];

		expect(await loadedToolNames()).not.toContain(TEAMS_TOOL);
	});

	it("org context: loads Teams tools from the caller's own connection", async () => {
		state.rows = [teammateTeams, callerTeams];

		expect(await loadedToolNames()).toContain(TEAMS_TOOL);
	});
});
