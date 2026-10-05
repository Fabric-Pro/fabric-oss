/**
 * Every MCP client built from a stored config is gated on the config owner's
 * current organization role (Fizzy #2903): background callers take the user
 * and organization from stored workflow or agent input, and the config row
 * keeps its credential after its owner leaves or is downgraded.
 *
 * `connect` (executing a tool) needs MCP_CONNECT, `read` (listing) needs
 * MCP_READ; the default is `connect`. A cached client is re-checked on every
 * call, for every server.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	connects: 0,
	clients: [] as Array<{
		tools: ReturnType<typeof vi.fn>;
		close: ReturnType<typeof vi.fn>;
	}>,
	canConnect: vi.fn(),
	canRead: vi.fn(),
	isMember: vi.fn(),
	getMcpConfigById: vi.fn(),
}));

vi.mock("@ai-sdk/mcp", () => ({
	createMCPClient: vi.fn(async () => {
		state.connects += 1;
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
	getMcpConfigById: (...args: unknown[]) => state.getMcpConfigById(...args),
	getValidAccessToken: vi.fn(async () => "api-key"),
	canConnectOrganizationMcpConfigs: (...args: unknown[]) =>
		state.canConnect(...args),
	canReadOrganizationMcpConfigs: (...args: unknown[]) =>
		state.canRead(...args),
	isOrganizationMember: (...args: unknown[]) => state.isMember(...args),
}));

vi.mock("../server-url-guard", () => ({
	assertMcpServerUrlResolved: vi.fn(async () => undefined),
	fetchMcpServer: vi.fn(),
}));

import {
	clearMcpClientCache,
	createMcpClientForConfig,
	getCachedMcpClientForConfig,
	McpClientError,
} from "../client";
import {
	checkMcpConfigOrganizationAccess,
	MCP_ORGANIZATION_MEMBERSHIP_REQUIRED,
	MCP_PERMISSION_DENIED,
} from "../organization-access";

const ORG = { configId: "cfg-1", userId: "user-1", organizationId: "org-1" };

function apiKeyConfig(organizationId: string | null = "org-1") {
	return {
		id: "cfg-1",
		userId: "user-1",
		organizationId,
		enabled: true,
		needsReauth: false,
		displayName: "Example Server",
		baseUrl: "https://mcp.example.com/mcp",
		transport: "HTTP",
		authType: "API_KEY",
		apiKeyMethod: "BEARER",
		mcpServer: {
			key: "example",
			name: "Example",
			defaultUrl: "https://mcp.example.com/mcp",
			transport: "HTTP",
		},
	};
}

/** A member: holds MCP_READ and MCP_CONNECT. */
function asMember() {
	state.canConnect.mockResolvedValue(true);
	state.canRead.mockResolvedValue(true);
	state.isMember.mockResolvedValue(true);
}

/** A viewer: holds MCP_READ only. */
function asViewer() {
	state.canConnect.mockResolvedValue(false);
	state.canRead.mockResolvedValue(true);
	state.isMember.mockResolvedValue(true);
}

/** No longer a member: holds nothing. */
function asRemoved() {
	state.canConnect.mockResolvedValue(false);
	state.canRead.mockResolvedValue(false);
	state.isMember.mockResolvedValue(false);
}

async function refusalOf(promise: Promise<unknown>): Promise<McpClientError> {
	const error = await promise.then(
		() => {
			throw new Error("expected a refusal");
		},
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(McpClientError);
	return error as McpClientError;
}

beforeEach(async () => {
	await clearMcpClientCache();
	state.connects = 0;
	state.clients = [];
	state.canConnect.mockReset();
	state.canRead.mockReset();
	state.isMember.mockReset();
	state.getMcpConfigById.mockReset();
	state.getMcpConfigById.mockImplementation(async () => apiKeyConfig());
});

describe("createMcpClientForConfig — organization access", () => {
	it("lets a member connect, asking only the connect question", async () => {
		asMember();

		const result = await createMcpClientForConfig({ ...ORG });

		expect(result.serverName).toBe("Example Server");
		expect(state.connects).toBe(1);
		expect(state.canConnect).toHaveBeenCalledWith("user-1", "org-1");
		expect(state.canRead).not.toHaveBeenCalled();
		expect(state.isMember).not.toHaveBeenCalled();
	});

	it("defaults to connect when the caller does not say", async () => {
		asViewer();

		const error = await refusalOf(createMcpClientForConfig({ ...ORG }));

		expect(error.code).toBe(MCP_PERMISSION_DENIED);
		expect(state.canConnect).toHaveBeenCalledTimes(1);
		expect(state.canRead).not.toHaveBeenCalled();
	});

	it("refuses a viewer for connect with MCP_PERMISSION_DENIED before the config is read", async () => {
		asViewer();

		const error = await refusalOf(
			createMcpClientForConfig({ ...ORG, access: "connect" }),
		);

		expect(error.code).toBe(MCP_PERMISSION_DENIED);
		expect(error.isAuthError).toBe(false);
		expect(error.message).not.toMatch(/user-1|org-1|cfg-1/);
		expect(state.getMcpConfigById).not.toHaveBeenCalled();
		expect(state.connects).toBe(0);
	});

	it("lets a viewer read", async () => {
		asViewer();

		await createMcpClientForConfig({ ...ORG, access: "read" });

		expect(state.connects).toBe(1);
		expect(state.canRead).toHaveBeenCalledWith("user-1", "org-1");
		expect(state.canConnect).not.toHaveBeenCalled();
	});

	it.each(["read", "connect"] as const)(
		"refuses a non-member (%s) with ORGANIZATION_MEMBERSHIP_REQUIRED before the config is read",
		async (access) => {
			asRemoved();

			const error = await refusalOf(
				createMcpClientForConfig({ ...ORG, access }),
			);

			expect(error.code).toBe(MCP_ORGANIZATION_MEMBERSHIP_REQUIRED);
			expect(error.message).not.toMatch(/user-1|org-1|cfg-1/);
			expect(state.getMcpConfigById).not.toHaveBeenCalled();
			expect(state.connects).toBe(0);
		},
	);

	it("refuses (throws the read's error) when the permission read fails, never allowing", async () => {
		state.canConnect.mockRejectedValue(new Error("database unavailable"));

		await expect(createMcpClientForConfig({ ...ORG })).rejects.toThrow(
			"database unavailable",
		);
		expect(state.getMcpConfigById).not.toHaveBeenCalled();
		expect(state.connects).toBe(0);
	});

	it("refuses when the membership read behind a refusal fails", async () => {
		state.canConnect.mockResolvedValue(false);
		state.isMember.mockRejectedValue(new Error("database unavailable"));

		await expect(createMcpClientForConfig({ ...ORG })).rejects.toThrow(
			"database unavailable",
		);
		expect(state.connects).toBe(0);
	});

	it("does not check a role in personal context (no organization)", async () => {
		state.getMcpConfigById.mockImplementation(async () =>
			apiKeyConfig(null),
		);

		await createMcpClientForConfig({ configId: "cfg-1", userId: "user-1" });

		expect(state.connects).toBe(1);
		expect(state.canConnect).not.toHaveBeenCalled();
		expect(state.canRead).not.toHaveBeenCalled();
		expect(state.isMember).not.toHaveBeenCalled();
		expect(state.getMcpConfigById).toHaveBeenCalledWith("cfg-1", {
			userId: "user-1",
			organizationId: undefined,
		});
	});
});

describe("getCachedMcpClientForConfig — organization access", () => {
	it("asks once on an uncached call and once per cached call", async () => {
		asMember();

		const created = await getCachedMcpClientForConfig({ ...ORG });
		expect(created.fromCache).toBe(false);
		expect(state.canConnect).toHaveBeenCalledTimes(1);

		const cached = await getCachedMcpClientForConfig({ ...ORG });
		expect(cached.fromCache).toBe(true);
		expect(state.canConnect).toHaveBeenCalledTimes(2);
		expect(state.connects).toBe(1);
	});

	it("refuses, drops and closes a cached (non-GitLab) client once its owner is removed", async () => {
		asMember();
		await getCachedMcpClientForConfig({ ...ORG });
		expect(state.connects).toBe(1);
		const [client] = state.clients;

		asRemoved();
		const error = await refusalOf(getCachedMcpClientForConfig({ ...ORG }));

		expect(error.code).toBe(MCP_ORGANIZATION_MEMBERSHIP_REQUIRED);
		expect(client.close).toHaveBeenCalledTimes(1);
		// Not health-checked, not replaced.
		expect(client.tools).not.toHaveBeenCalled();
		expect(state.connects).toBe(1);

		// The entry is gone: a member again gets a new connection.
		asMember();
		const again = await getCachedMcpClientForConfig({ ...ORG });
		expect(again.fromCache).toBe(false);
		expect(state.connects).toBe(2);
	});

	it("refuses a cached client to a viewer for connect but serves it for read", async () => {
		asMember();
		await getCachedMcpClientForConfig({ ...ORG, access: "read" });

		asViewer();
		const error = await refusalOf(
			getCachedMcpClientForConfig({ ...ORG, access: "connect" }),
		);
		expect(error.code).toBe(MCP_PERMISSION_DENIED);
		expect(state.clients[0].close).toHaveBeenCalledTimes(1);

		const read = await getCachedMcpClientForConfig({
			...ORG,
			access: "read",
		});
		expect(read.fromCache).toBe(false);
		expect(state.connects).toBe(2);
	});

	it("drops and closes a cached client when the permission read fails, and throws", async () => {
		asMember();
		await getCachedMcpClientForConfig({ ...ORG });
		const [client] = state.clients;

		state.canConnect.mockRejectedValue(new Error("database unavailable"));
		await expect(getCachedMcpClientForConfig({ ...ORG })).rejects.toThrow(
			"database unavailable",
		);
		expect(client.close).toHaveBeenCalledTimes(1);

		asMember();
		const again = await getCachedMcpClientForConfig({ ...ORG });
		expect(again.fromCache).toBe(false);
	});

	it("does not check a role for a cached personal client", async () => {
		state.getMcpConfigById.mockImplementation(async () =>
			apiKeyConfig(null),
		);
		const personal = { configId: "cfg-1", userId: "user-1" };

		await getCachedMcpClientForConfig(personal);
		const cached = await getCachedMcpClientForConfig(personal);

		expect(cached.fromCache).toBe(true);
		expect(state.canConnect).not.toHaveBeenCalled();
		expect(state.isMember).not.toHaveBeenCalled();
	});
});

describe("checkMcpConfigOrganizationAccess", () => {
	it("checks any access other than read as connect", async () => {
		asViewer();

		const refusal = await checkMcpConfigOrganizationAccess({
			userId: "user-1",
			organizationId: "org-1",
			access: "write" as unknown as "read",
		});

		expect(refusal?.code).toBe(MCP_PERMISSION_DENIED);
		expect(state.canConnect).toHaveBeenCalledTimes(1);
		expect(state.canRead).not.toHaveBeenCalled();
	});
});
