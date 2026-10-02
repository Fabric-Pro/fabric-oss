/**
 * The orchestrator preload exposes GitHub and Microsoft Teams tools when the
 * CALLER has an active connection. In an organization each member's
 * connection is a personal OAuth grant: a member who never connected (or
 * disconnected) must not get those tools because a teammate is connected.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	connectionRow,
	type FakeWorkflowIntegrationRow,
} from "./helpers/workflow-integration-fake";

const state = vi.hoisted(() => ({
	rows: [] as FakeWorkflowIntegrationRow[],
}));

vi.mock("@repo/database", async () => {
	const { createWorkflowIntegrationFake } = await import(
		"./helpers/workflow-integration-fake"
	);
	// Every other model the preload touches reads as empty.
	const emptyModel = {
		findUnique: async () => null,
		findFirst: async () => null,
		findMany: async () => [],
	};
	return {
		db: new Proxy(
			{},
			{
				get: (_target, model) =>
					model === "workflowIntegration"
						? createWorkflowIntegrationFake(state.rows)
						: emptyModel,
			},
		),
		loadProjectDatabricksKnowledgeBinding: vi.fn().mockResolvedValue(null),
	};
});

vi.mock("../src/activities/shared/databricks-knowledge", () => ({
	buildDatabricksKnowledgeToolDefinition: vi.fn(),
	databricksKnowledgeToolName: vi.fn(),
	loadAgentDatabricksBindings: vi.fn().mockResolvedValue([]),
	mergeDatabricksBindings: () => [],
}));

vi.mock("@repo/mcp-registry", () => {
	const account = (id: string, serverName: string, toolName: string) => ({
		id,
		mcps: [
			{
				id: `${id}-mcp`,
				name: serverName,
				serverName,
				tools: [{ name: toolName, description: "", inputSchema: {} }],
			},
		],
	});
	return {
		GITHUB_ACCOUNT: account("github", "GitHub", "list_repos"),
		MICROSOFT_TEAMS_ACCOUNT: account("teams", "Teams", "list_chats"),
		getAlwaysEnabledWorkflowGuidance: () => "",
		getGuidanceByServerName: () => undefined,
	};
});

import { preloadResourcesActivity } from "../src/activities/orchestrator/preload/preload-resources";

const GITHUB_TOOL = "GitHub__list_repos";
const TEAMS_TOOL = "Teams__list_chats";

// Teammate rows are seeded FIRST, so a lookup that drops userId in the
// organization arm picks them up.
const teammateRows = [
	connectionRow({
		id: "wi-gh-teammate",
		userId: "user-1",
		provider: "GITHUB",
	}),
	connectionRow({
		id: "wi-ms-teammate",
		userId: "user-1",
		provider: "MICROSOFT_GRAPH",
	}),
];
const callerRows = [
	connectionRow({ id: "wi-gh-caller", userId: "user-2", provider: "GITHUB" }),
	connectionRow({
		id: "wi-ms-caller",
		userId: "user-2",
		provider: "MICROSOFT_GRAPH",
	}),
];

function preload(enabledIntegrationIds?: string[]) {
	return preloadResourcesActivity({
		userId: "user-2",
		organizationId: "org-example",
		enabledMcpConfigIds: enabledIntegrationIds
			? enabledIntegrationIds.map((id) => `oauth:integration:${id}`)
			: undefined,
		enabledIntegrationIds,
	});
}

beforeEach(() => {
	state.rows = [];
});

describe("preload OAuth integration tools: connection owner", () => {
	it("org context: does not expose GitHub or Teams tools from a teammate's connection", async () => {
		state.rows = [...teammateRows];

		const { toolMap } = await preload();

		expect(toolMap[GITHUB_TOOL]).toBeUndefined();
		expect(toolMap[TEAMS_TOOL]).toBeUndefined();
	});

	it("org context: exposes the tools from the caller's own connections", async () => {
		state.rows = [...teammateRows, ...callerRows];

		// The enable filter is keyed by integration id, so this only passes
		// when the lookup resolved the CALLER's rows.
		const { toolMap } = await preload(["wi-gh-caller", "wi-ms-caller"]);

		expect(toolMap[GITHUB_TOOL]).toBeDefined();
		expect(toolMap[TEAMS_TOOL]).toBeDefined();
	});
});
