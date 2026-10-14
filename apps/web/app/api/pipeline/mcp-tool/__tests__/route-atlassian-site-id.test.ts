import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	authorizeMcpConfigRequest: vi.fn(),
	getCachedMcpClientForConfig: vi.fn(),
	callMcpTool: vi.fn(),
	getMcpConfigById: vi.fn(),
}));

vi.mock("@saas/auth/lib/server", () => ({
	getSession: mocks.getSession,
}));

vi.mock("@saas/mcp/lib/authorize-mcp-config-request", () => ({
	authorizeMcpConfigRequest: mocks.authorizeMcpConfigRequest,
}));

vi.mock("@repo/mcp", () => ({
	getCachedMcpClientForConfig: mocks.getCachedMcpClientForConfig,
	callMcpTool: mocks.callMcpTool,
	invalidateMcpClientCache: vi.fn(),
	McpClientError: class extends Error {},
}));

vi.mock("@repo/database", () => ({
	getMcpConfigById: mocks.getMcpConfigById,
}));

import { clearSiteIdCacheForTests } from "../atlassian-cloud-id";
import { POST } from "../route";

const UUID_SITE = "11111111-1111-4111-8111-111111111111";
const STORED_UUID_SITE = "22222222-2222-4222-8222-222222222222";
const CALLER_UUID_SITE = "33333333-3333-4333-8333-333333333333";

function createJsonTool(
	paramsSchema: Record<string, unknown>,
	required: string[] = [],
) {
	return {
		inputSchema: {
			type: "object",
			properties: paramsSchema,
			required,
		},
		execute: vi.fn().mockResolvedValue({ success: true }),
	};
}

function makeRequest(body: Record<string, unknown>) {
	return new NextRequest("http://localhost:3000/api/pipeline/mcp-tool", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("POST /api/pipeline/mcp-tool — Atlassian site ID resolution & injection", () => {
	let jiraTool: ReturnType<typeof createJsonTool>;
	let resolverTool: ReturnType<typeof createJsonTool>;

	beforeEach(() => {
		vi.resetAllMocks();
		clearSiteIdCacheForTests();

		mocks.getSession.mockResolvedValue({
			user: { id: "user-1" },
		});
		mocks.authorizeMcpConfigRequest.mockResolvedValue({
			ok: true,
		});
		mocks.callMcpTool.mockImplementation(
			async ({ execute }: { execute: () => Promise<unknown> }) =>
				execute(),
		);

		jiraTool = createJsonTool({ cloudId: {}, query: {} }, ["cloudId"]);
		resolverTool = createJsonTool({});
		resolverTool.execute.mockResolvedValue([{ id: UUID_SITE }]);

		mocks.getCachedMcpClientForConfig.mockResolvedValue({
			client: {
				tools: async () => ({
					getJiraProjects: jiraTool,
					getAccessibleAtlassianResources: resolverTool,
				}),
			},
			serverName: "Atlassian",
		});
	});

	it("resolves and injects cloudId for system Atlassian with nothing stored", async () => {
		mocks.getMcpConfigById.mockResolvedValue({
			id: "cfg-1",
			atlassianCloudCloudId: null,
			oauthGrantGeneration: 3,
			mcpServer: { key: "atlassian", isSystemProvided: true },
		});

		const req = makeRequest({
			mcpConfigId: "cfg-1",
			toolName: "getJiraProjects",
			params: { query: "sandbox" },
		});

		const res = await POST(req);
		expect(res.status).toBe(200);

		expect(resolverTool.execute).toHaveBeenCalledTimes(1);
		expect(jiraTool.execute).toHaveBeenCalledWith(
			{ query: "sandbox", cloudId: UUID_SITE },
			expect.any(Object),
		);
	});

	it("caches resolved cloudId across requests with same generation, but re-resolves if generation changes", async () => {
		mocks.getMcpConfigById.mockResolvedValue({
			id: "cfg-1",
			atlassianCloudCloudId: null,
			oauthGrantGeneration: 1,
			mcpServer: { key: "atlassian", isSystemProvided: true },
		});

		const req1 = makeRequest({
			mcpConfigId: "cfg-1",
			toolName: "getJiraProjects",
			params: { query: "first" },
		});
		const res1 = await POST(req1);
		expect(res1.status).toBe(200);
		expect(resolverTool.execute).toHaveBeenCalledTimes(1);

		// Second call with same generation hits in-memory cache
		const req2 = makeRequest({
			mcpConfigId: "cfg-1",
			toolName: "getJiraProjects",
			params: { query: "second" },
		});
		const res2 = await POST(req2);
		expect(res2.status).toBe(200);
		expect(resolverTool.execute).toHaveBeenCalledTimes(1);

		// Third call with bumped generation misses cache and re-resolves
		mocks.getMcpConfigById.mockResolvedValue({
			id: "cfg-1",
			atlassianCloudCloudId: null,
			oauthGrantGeneration: 2,
			mcpServer: { key: "atlassian", isSystemProvided: true },
		});
		const req3 = makeRequest({
			mcpConfigId: "cfg-1",
			toolName: "getJiraProjects",
			params: { query: "third" },
		});
		const res3 = await POST(req3);
		expect(res3.status).toBe(200);
		expect(resolverTool.execute).toHaveBeenCalledTimes(2);
	});

	it("never calls resolver and leaves cloudId empty for custom Atlassian row", async () => {
		mocks.getMcpConfigById.mockResolvedValue({
			id: "cfg-custom",
			atlassianCloudCloudId: null,
			mcpServer: { key: "atlassian", isSystemProvided: false },
		});

		const req = makeRequest({
			mcpConfigId: "cfg-custom",
			toolName: "getJiraProjects",
			params: { query: "sandbox" },
		});

		const res = await POST(req);
		expect(res.status).toBe(200);

		expect(resolverTool.execute).not.toHaveBeenCalled();
		expect(jiraTool.execute).toHaveBeenCalledWith(
			{ query: "sandbox" },
			expect.any(Object),
		);
	});

	it("never calls resolver for a non-Atlassian server declaring cloudId", async () => {
		mocks.getMcpConfigById.mockResolvedValue({
			id: "cfg-notion",
			atlassianCloudCloudId: null,
			mcpServer: { key: "notion", isSystemProvided: true },
		});

		const req = makeRequest({
			mcpConfigId: "cfg-notion",
			toolName: "getJiraProjects",
			params: { query: "sandbox" },
		});

		const res = await POST(req);
		expect(res.status).toBe(200);

		expect(resolverTool.execute).not.toHaveBeenCalled();
		expect(jiraTool.execute).toHaveBeenCalledWith(
			{ query: "sandbox" },
			expect.any(Object),
		);
	});

	it("injects stored ID without calling resolver on a non-system row with stored ID", async () => {
		mocks.getMcpConfigById.mockResolvedValue({
			id: "cfg-custom-stored",
			atlassianCloudCloudId: STORED_UUID_SITE,
			mcpServer: { key: "atlassian", isSystemProvided: false },
		});

		const req = makeRequest({
			mcpConfigId: "cfg-custom-stored",
			toolName: "getJiraProjects",
			params: { query: "sandbox" },
		});

		const res = await POST(req);
		expect(res.status).toBe(200);

		expect(resolverTool.execute).not.toHaveBeenCalled();
		expect(jiraTool.execute).toHaveBeenCalledWith(
			{ query: "sandbox", cloudId: STORED_UUID_SITE },
			expect.any(Object),
		);
	});

	it("does not look up config or resolver when caller already passed cloudId", async () => {
		const req = makeRequest({
			mcpConfigId: "cfg-1",
			toolName: "getJiraProjects",
			params: { query: "sandbox", cloudId: CALLER_UUID_SITE },
		});

		const res = await POST(req);
		expect(res.status).toBe(200);

		expect(mocks.getMcpConfigById).not.toHaveBeenCalled();
		expect(resolverTool.execute).not.toHaveBeenCalled();
		expect(jiraTool.execute).toHaveBeenCalledWith(
			{ query: "sandbox", cloudId: CALLER_UUID_SITE },
			expect.any(Object),
		);
	});
});
