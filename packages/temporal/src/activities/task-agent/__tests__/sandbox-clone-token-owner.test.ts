/**
 * The task agent's Sandbox `createSession` injects a GitHub token when it
 * clones a GitHub repository. In an organization that token must be the
 * CALLER's own GitHub connection: each member's connection is a personal
 * OAuth grant, so a member who never connected GitHub (or disconnected it)
 * must not clone through a teammate's account.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	connectionRow,
	type FakeWorkflowIntegrationRow,
} from "../../../../__tests__/helpers/workflow-integration-fake";

const state = vi.hoisted(() => ({
	rows: [] as FakeWorkflowIntegrationRow[],
}));

vi.mock("@repo/database", async () => {
	const { createWorkflowIntegrationFake: fake } = await import(
		"../../../../__tests__/helpers/workflow-integration-fake"
	);
	return {
		db: {
			get workflowIntegration() {
				return fake(state.rows);
			},
		},
		getAiProviderApiKeyByProvider: vi.fn(),
	};
});

vi.mock("@repo/utils", () => ({
	// Rows in the fake store plaintext JSON.
	decryptApiKey: (value: string) => value,
	getBaseUrl: () => "https://example.com",
}));

vi.mock("@repo/integrations/github", () => ({ executeGitHubTool: vi.fn() }));
vi.mock("@repo/mcp", () => ({
	getCachedMcpClientForConfig: vi.fn(),
	OAuthAuthorizationRequiredError: class extends Error {},
}));
vi.mock("@repo/mcp-registry", () => ({ getAlwaysEnabledMcps: () => [] }));
vi.mock("../../shared/oauth-tool-executors", () => ({
	executeMicrosoftTeamsTool: vi.fn(),
}));
vi.mock("../../shared/read-only-gate", () => ({
	guardToolWriteForReadOnly: vi.fn().mockResolvedValue(null),
}));

const createSandboxSession = vi.hoisted(() =>
	vi.fn(async (input: unknown) => ({ sessionId: "session-1", input })),
);
vi.mock("../../sandbox", () => ({ createSandboxSession }));

import { executeTaskAgentTool } from "../mcp-tools";

function createSession(userId: string, organizationId?: string) {
	return executeTaskAgentTool({
		toolName: "Sandbox__createSession",
		args: { repoUrl: "https://github.com/example/repo" },
		userId,
		organizationId,
		mcpConfig: {
			tools: [
				{
					name: "Sandbox__createSession",
					description: "",
					inputSchema: {},
					configId: "always-enabled:sandbox:sandbox",
					serverName: "Sandbox",
				},
			],
		},
	});
}

function injectedToken(): unknown {
	const input = createSandboxSession.mock.calls[0]?.[0] as
		| { githubToken?: unknown }
		| undefined;
	return input?.githubToken;
}

// The teammate's row is seeded FIRST, so a lookup that drops userId in the
// organization arm picks it up.
const teammateGitHub = connectionRow({
	id: "wi-teammate",
	userId: "user-1",
	provider: "GITHUB",
});
const callerGitHub = connectionRow({
	id: "wi-caller",
	userId: "user-2",
	provider: "GITHUB",
});

beforeEach(() => {
	createSandboxSession.mockClear();
	state.rows = [];
});

describe("task agent createSession GitHub clone token", () => {
	it("org context: clones with the caller's own GitHub token, not a teammate's", async () => {
		state.rows = [teammateGitHub, callerGitHub];

		await createSession("user-2", "org-example");

		expect(injectedToken()).toBe("wi-caller-token");
	});

	it("org context: never borrows a teammate's GitHub token when the caller has none", async () => {
		state.rows = [teammateGitHub];

		await createSession("user-2", "org-example");

		expect(createSandboxSession).toHaveBeenCalledTimes(1);
		expect(injectedToken()).toBeUndefined();
	});

	it("personal context: uses only the caller's personal connection", async () => {
		state.rows = [
			teammateGitHub,
			connectionRow({
				id: "wi-personal",
				userId: "user-2",
				organizationId: null,
				provider: "GITHUB",
			}),
		];

		await createSession("user-2");

		expect(injectedToken()).toBe("wi-personal-token");
	});
});
