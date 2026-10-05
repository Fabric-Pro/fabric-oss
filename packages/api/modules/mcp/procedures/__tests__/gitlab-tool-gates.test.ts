/**
 * `mcp.tools.list` and `mcp.tools.refresh` gate a GitLab personal server
 * (`gitlab`, `gitlab-official`) on the person's GitLab connection whatever
 * auth type its config names. A config saved as API_KEY (an older release
 * let the API store a personal access token there) must not be treated as
 * an ordinary API-key server: its cached tools are not served and no
 * ingestion starts while GitLab is not connected.
 *
 * Mocking mirrors `configs-authtype-transition.test.ts`: the procedure
 * builder is mocked so `.handler(fn)` captures the handler under `._handler`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	getMcpConfigByIdMock,
	getMcpConfigCachedToolsMock,
	blockerMock,
	triggerMcpToolIngestionMock,
	createMcpClientForConfigMock,
} = vi.hoisted(() => ({
	getMcpConfigByIdMock: vi.fn(),
	getMcpConfigCachedToolsMock: vi.fn(),
	blockerMock: vi.fn(),
	triggerMcpToolIngestionMock: vi.fn(),
	createMcpClientForConfigMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	// Mirrors the real predicate (prisma/queries/lib/gitlab-personal-keys.ts).
	isGitLabPersonalMcpServerKey: (key: string | null | undefined) =>
		key === "gitlab" || key === "gitlab-official",
	getMcpConfigById: (...args: unknown[]) => getMcpConfigByIdMock(...args),
	getMcpConfigCachedTools: (...args: unknown[]) =>
		getMcpConfigCachedToolsMock(...args),
}));

vi.mock("@repo/mcp", () => ({
	closeMcpClient: vi.fn(),
	createMcpClientForConfig: (...args: unknown[]) =>
		createMcpClientForConfigMock(...args),
}));

vi.mock("@repo/temporal", () => ({
	triggerMcpToolIngestion: (...args: unknown[]) =>
		triggerMcpToolIngestionMock(...args),
}));

vi.mock("../../lib/gitlab-connection-gate", () => ({
	gitlabMcpConnectionBlocker: (...args: unknown[]) => blockerMock(...args),
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	});
	return {
		tenantProtectedProcedure: chainable,
		requirePermission: () => () => ({}),
		authorizeInputOrganization: async (
			_permission: string,
			organizationId: string | null | undefined,
		) => organizationId ?? null,
		Permissions: {
			MCP_CONNECT: "mcp:connect",
			MCP_READ: "mcp:read",
		} as const,
	};
});

import { listToolsProcedure } from "../list-tools";
import { refreshToolsProcedure } from "../refresh-tools";

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string } };
}) => Promise<Record<string, unknown>>;
const listHandler = (listToolsProcedure as unknown as { _handler: Handler })
	._handler;
const refreshHandler = (
	refreshToolsProcedure as unknown as { _handler: Handler }
)._handler;

const NOT_CONNECTED = "GitLab is not connected. Connect GitLab first.";

function config(serverKey: string, authType: string) {
	return {
		id: "cfg_1",
		enabled: true,
		displayName: null,
		authType,
		encryptedApiKey: authType === "API_KEY" ? "enc:glpat-on-config" : null,
		encryptedAccessToken: null,
		tokenExpiresAt: null,
		transport: "HTTP",
		baseUrl: null,
		mcpServer: {
			key: serverKey,
			name: "GitLab",
			transport: "HTTP",
			defaultUrl: "https://gitlab.com/api/v4/mcp",
		},
	};
}

const CASES: Array<[string, string]> = [
	["gitlab", "API_KEY"],
	["gitlab-official", "API_KEY"],
	["gitlab", "NONE"],
	["gitlab-official", "OAUTH2"],
];

beforeEach(() => {
	vi.clearAllMocks();
	getMcpConfigCachedToolsMock.mockResolvedValue({
		tools: [{ name: "get_issue", description: null, inputSchema: {} }],
		toolCount: 1,
		cachedAt: new Date("2026-10-01T00:00:00Z"),
	});
	triggerMcpToolIngestionMock.mockResolvedValue({ workflowId: "wf_1" });
});

describe("mcp.tools.list — GitLab personal servers follow the connection", () => {
	it.each(CASES)(
		"does not serve cached tools for a %s config with authType %s while GitLab is not connected",
		async (serverKey, authType) => {
			getMcpConfigByIdMock.mockResolvedValue(config(serverKey, authType));
			blockerMock.mockResolvedValue(NOT_CONNECTED);

			const result = await listHandler({
				input: { serverIds: ["cfg_1"], organizationId: "org_1" },
				context: { user: { id: "user_1" } },
			});

			expect(blockerMock).toHaveBeenCalledWith({
				userId: "user_1",
				organizationId: "org_1",
			});
			expect(result.tools).toEqual([]);
			expect(result.errors).toEqual([
				expect.objectContaining({
					serverId: "cfg_1",
					error: NOT_CONNECTED,
				}),
			]);
			expect(getMcpConfigCachedToolsMock).not.toHaveBeenCalled();
			expect(createMcpClientForConfigMock).not.toHaveBeenCalled();
		},
	);

	it("serves cached tools for an API_KEY gitlab config once GitLab is connected", async () => {
		getMcpConfigByIdMock.mockResolvedValue(config("gitlab", "API_KEY"));
		blockerMock.mockResolvedValue(null);

		const result = await listHandler({
			input: { serverIds: ["cfg_1"], organizationId: "org_1" },
			context: { user: { id: "user_1" } },
		});

		expect(result.tools).toEqual([
			expect.objectContaining({ name: "get_issue", fromCache: true }),
		]);
	});

	it("does not consult the GitLab connection for any other API-key server (control)", async () => {
		getMcpConfigByIdMock.mockResolvedValue(config("linear", "API_KEY"));

		const result = await listHandler({
			input: { serverIds: ["cfg_1"], organizationId: "org_1" },
			context: { user: { id: "user_1" } },
		});

		expect(blockerMock).not.toHaveBeenCalled();
		expect(result.tools).toHaveLength(1);
	});
});

describe("mcp.tools.refresh — GitLab personal servers follow the connection", () => {
	it.each(CASES)(
		"starts no ingestion for a %s config with authType %s while GitLab is not connected",
		async (serverKey, authType) => {
			getMcpConfigByIdMock.mockResolvedValue(config(serverKey, authType));
			blockerMock.mockResolvedValue(NOT_CONNECTED);

			const result = await refreshHandler({
				input: { serverIds: ["cfg_1"], organizationId: "org_1" },
				context: { user: { id: "user_1" } },
			});

			expect(result.results).toEqual([
				expect.objectContaining({
					serverId: "cfg_1",
					success: false,
					error: NOT_CONNECTED,
				}),
			]);
			expect(triggerMcpToolIngestionMock).not.toHaveBeenCalled();
		},
	);

	it("starts ingestion for an API_KEY gitlab config once GitLab is connected", async () => {
		getMcpConfigByIdMock.mockResolvedValue(config("gitlab", "API_KEY"));
		blockerMock.mockResolvedValue(null);

		const result = await refreshHandler({
			input: { serverIds: ["cfg_1"], organizationId: "org_1" },
			context: { user: { id: "user_1" } },
		});

		expect(triggerMcpToolIngestionMock).toHaveBeenCalledOnce();
		expect(result.results).toEqual([
			expect.objectContaining({ success: true, workflowId: "wf_1" }),
		]);
	});
});
