/**
 * A caller acting on a project's GitLab PM container passes the instance the
 * container lives on (`expectedGitLabOrigin`). The client it gets must be
 * bound to that instance — checked on the client actually acquired, new or
 * cached — because the config or the person's connection can move to another
 * instance after the caller's own check, and a container id sent there names
 * an unrelated project.
 *
 * Here the container lives on gitlab.com and the config moves to
 * gitlab.example.com.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	config: null as Record<string, unknown> | null,
	connects: [] as string[],
	clients: [] as Array<{ tools: ReturnType<typeof vi.fn> }>,
	transportAuth: vi.fn(),
}));

vi.mock("@ai-sdk/mcp", () => ({
	createMCPClient: vi.fn(async (args: { transport: { _url?: URL } }) => {
		state.connects.push(String(args.transport._url ?? ""));
		const client = {
			tools: vi.fn(async () => ({})),
			close: vi.fn(async () => undefined),
		};
		state.clients.push(client);
		return client;
	}),
}));

vi.mock("@repo/database", () => ({
	isGitLabPersonalMcpServerKey: (key: string | null | undefined) =>
		key === "gitlab" || key === "gitlab-official",
	getMcpConfigById: vi.fn(async () => state.config),
	getValidAccessToken: vi.fn(async () => "api-key"),
	// The config owner is a member whose role allows MCP read and connect
	// (the organization gate in ../organization-access).
	canConnectOrganizationMcpConfigs: async () => true,
	canReadOrganizationMcpConfigs: async () => true,
	isOrganizationMember: async () => true,
}));

vi.mock("../server-url-guard", () => ({
	assertMcpServerUrlResolved: vi.fn(async () => undefined),
	fetchMcpServer: vi.fn(),
}));

vi.mock("../gitlab-credential", async (importOriginal) => ({
	...(await importOriginal<object>()),
	getGitLabMcpTransportAuth: (...args: unknown[]) =>
		state.transportAuth(...args),
}));

import {
	clearMcpClientCache,
	createMcpClientForConfig,
	getCachedMcpClientForConfig,
	McpGitLabOriginMismatchError,
} from "../client";

const TENANT = { userId: "user-1", organizationId: "org-1" };

function gitlabConfig(baseUrl: string) {
	return {
		id: "cfg-gl",
		userId: "user-1",
		organizationId: "org-1",
		enabled: true,
		needsReauth: false,
		displayName: "GitLab",
		baseUrl,
		transport: "HTTP",
		authType: "OAUTH2",
		apiKeyMethod: "BEARER",
		mcpServer: {
			key: "gitlab-official",
			name: "GitLab",
			defaultUrl: "https://gitlab.com/api/v4/mcp",
			transport: "HTTP",
		},
	};
}

beforeEach(async () => {
	await clearMcpClientCache();
	state.connects = [];
	state.clients = [];
	state.transportAuth.mockReset();
	state.transportAuth.mockImplementation(async () => ({
		accessToken: "token",
		fetch: vi.fn(),
	}));
});

describe("GitLab MCP clients bound to a PM container's instance", () => {
	it("refuses a new client for a config on another instance before a token is read or anything connects", async () => {
		state.config = gitlabConfig("https://gitlab.example.com/api/v4/mcp");

		await expect(
			createMcpClientForConfig({
				configId: "cfg-gl",
				...TENANT,
				expectedGitLabOrigin: "https://gitlab.com",
			}),
		).rejects.toBeInstanceOf(McpGitLabOriginMismatchError);
		expect(state.transportAuth).not.toHaveBeenCalled();
		expect(state.connects).toEqual([]);
	});

	it("refuses a cached client bound to another instance without using it", async () => {
		// A client built while the config pointed at gitlab.example.com.
		state.config = gitlabConfig("https://gitlab.example.com/api/v4/mcp");
		const first = await getCachedMcpClientForConfig({
			configId: "cfg-gl",
			...TENANT,
		});
		expect(first.gitlabOrigin).toBe("https://gitlab.example.com");
		expect(state.connects).toHaveLength(1);

		await expect(
			getCachedMcpClientForConfig({
				configId: "cfg-gl",
				...TENANT,
				expectedGitLabOrigin: "https://gitlab.com",
			}),
		).rejects.toBeInstanceOf(McpGitLabOriginMismatchError);
		// No new connection, and the cached client was not even health-checked.
		expect(state.connects).toHaveLength(1);
		expect(state.clients[0].tools).not.toHaveBeenCalled();
	});

	it("refuses a new client when the config moved between a bound caller's check and acquisition", async () => {
		// Nothing cached yet; the caller checked gitlab.com, the config now
		// says gitlab.example.com.
		state.config = gitlabConfig("https://gitlab.example.com/api/v4/mcp");

		await expect(
			getCachedMcpClientForConfig({
				configId: "cfg-gl",
				...TENANT,
				expectedGitLabOrigin: "https://gitlab.com",
			}),
		).rejects.toBeInstanceOf(McpGitLabOriginMismatchError);
		expect(state.connects).toEqual([]);
	});

	it("serves a client on the expected instance, new and cached", async () => {
		state.config = gitlabConfig("https://gitlab.com/api/v4/mcp");

		const created = await getCachedMcpClientForConfig({
			configId: "cfg-gl",
			...TENANT,
			expectedGitLabOrigin: "https://gitlab.com",
		});
		const cached = await getCachedMcpClientForConfig({
			configId: "cfg-gl",
			...TENANT,
			expectedGitLabOrigin: "https://gitlab.com",
		});

		expect(created).toMatchObject({
			fromCache: false,
			gitlabOrigin: "https://gitlab.com",
		});
		expect(cached).toMatchObject({
			fromCache: true,
			gitlabOrigin: "https://gitlab.com",
		});
		expect(state.connects).toHaveLength(1);
	});

	it("binds a GitLab config whatever its auth type", async () => {
		state.config = {
			...gitlabConfig("https://gitlab.example.com/api/v4/mcp"),
			authType: "API_KEY",
		};

		await expect(
			createMcpClientForConfig({
				configId: "cfg-gl",
				...TENANT,
				expectedGitLabOrigin: "https://gitlab.com",
			}),
		).rejects.toBeInstanceOf(McpGitLabOriginMismatchError);
		expect(state.connects).toEqual([]);
	});

	it("leaves other servers alone", async () => {
		state.config = {
			...gitlabConfig("https://mcp.example.com/mcp"),
			authType: "API_KEY",
			mcpServer: {
				key: "atlassian",
				name: "Atlassian",
				defaultUrl: "https://mcp.example.com/mcp",
				transport: "HTTP",
			},
		};

		const result = await createMcpClientForConfig({
			configId: "cfg-gl",
			...TENANT,
			expectedGitLabOrigin: "https://gitlab.com",
		});

		expect(result.gitlabOrigin).toBeUndefined();
		expect(state.connects).toHaveLength(1);
	});
});
