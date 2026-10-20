/**
 * A failed call evicts the cached client it used, and only that one: a
 * concurrent call may already have replaced it with a healthy client, which
 * other calls are using.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	config: null as Record<string, unknown> | null,
	connects: [] as string[],
	clients: [] as Array<{
		tools: ReturnType<typeof vi.fn>;
		close: ReturnType<typeof vi.fn>;
	}>,
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
	getCachedMcpClientForConfig,
	invalidateMcpClientCache,
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

describe("invalidateMcpClientCache", () => {
	it("leaves a replacement client cached when given the client that failed", async () => {
		state.config = gitlabConfig("https://gitlab.com/api/v4/mcp");
		const stale = await getCachedMcpClientForConfig({
			configId: "cfg-gl",
			...TENANT,
		});
		// A concurrent call already replaced the stale client.
		await invalidateMcpClientCache(
			"cfg-gl",
			TENANT.userId,
			TENANT.organizationId,
		);
		const replacement = await getCachedMcpClientForConfig({
			configId: "cfg-gl",
			...TENANT,
		});
		expect(replacement.client).not.toBe(stale.client);

		await invalidateMcpClientCache(
			"cfg-gl",
			TENANT.userId,
			TENANT.organizationId,
			stale.client,
		);

		const after = await getCachedMcpClientForConfig({
			configId: "cfg-gl",
			...TENANT,
		});
		expect(after).toMatchObject({ fromCache: true });
		expect(after.client).toBe(replacement.client);
		expect(state.clients[1].close).not.toHaveBeenCalled();
	});

	it("keeps a client cached by another call while the failed one is still closing", async () => {
		state.config = gitlabConfig("https://gitlab.com/api/v4/mcp");
		const failed = await getCachedMcpClientForConfig({
			configId: "cfg-gl",
			...TENANT,
		});
		let finishClose: () => void = () => undefined;
		state.clients[0].close.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finishClose = resolve;
				}),
		);

		const invalidating = invalidateMcpClientCache(
			"cfg-gl",
			TENANT.userId,
			TENANT.organizationId,
			failed.client,
		);
		// Another call acquires a client while the close is in flight.
		const replacement = await getCachedMcpClientForConfig({
			configId: "cfg-gl",
			...TENANT,
		});
		finishClose();
		await invalidating;

		const after = await getCachedMcpClientForConfig({
			configId: "cfg-gl",
			...TENANT,
		});
		expect(after).toMatchObject({ fromCache: true });
		expect(after.client).toBe(replacement.client);
	});

	it("evicts and closes the cached client when it is the one that failed", async () => {
		state.config = gitlabConfig("https://gitlab.com/api/v4/mcp");
		const used = await getCachedMcpClientForConfig({
			configId: "cfg-gl",
			...TENANT,
		});

		await invalidateMcpClientCache(
			"cfg-gl",
			TENANT.userId,
			TENANT.organizationId,
			used.client,
		);

		expect(state.clients[0].close).toHaveBeenCalledTimes(1);
		const after = await getCachedMcpClientForConfig({
			configId: "cfg-gl",
			...TENANT,
		});
		expect(after.fromCache).toBe(false);
	});
});
