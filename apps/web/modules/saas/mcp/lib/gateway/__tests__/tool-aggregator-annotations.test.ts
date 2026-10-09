/**
 * A connected server's own tool annotations reach the gateway's tool list
 * (security audit of the MCP gateway, finding 1b).
 *
 * The authority gate reads `readOnlyHint` to decide whether a delegated
 * credential may call a tool as a read. It was never given any: the aggregator
 * dropped annotations, so the gate had only the tool's name to go on.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listMcpConfigsForTenant: vi.fn(),
	updateMcpConfigToolCache: vi.fn(),
	getCachedMcpClientForConfig: vi.fn(),
}));

vi.mock("@repo/api/modules/v1/instruction-direct-repository", () => ({
	getDirectRepositoryState: vi
		.fn()
		.mockResolvedValue({ availability: "UPLOAD", readState: "DIRECT" }),
}));

vi.mock("@repo/database", () => ({
	listMcpConfigsForTenant: mocks.listMcpConfigsForTenant,
	updateMcpConfigToolCache: mocks.updateMcpConfigToolCache,
}));

vi.mock("@repo/mcp", () => ({
	getCachedMcpClientForConfig: mocks.getCachedMcpClientForConfig,
}));

import { getAggregatedTools } from "../tool-aggregator";
import type { GatewaySession } from "../types";

function session(userId: string): GatewaySession {
	return {
		sessionId: "session-1",
		userId,
		organizationId: "org-example-alpha",
		projectId: null,
		userName: "Dev",
		email: "dev@example.com",
		role: "user",
		credential: "oauth",
		scopes: ["mcp:read"],
		createdAt: new Date("2026-10-04T12:00:00Z"),
		expiresAt: new Date("2026-10-05T12:00:00Z"),
	};
}

function config(overrides: Record<string, unknown>) {
	return {
		id: "config-1",
		displayName: "Example",
		enabled: true,
		cachedTools: null,
		toolsCachedAt: null,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.updateMcpConfigToolCache.mockResolvedValue({});
});

describe("annotations on connected tools", () => {
	it("are carried from the cached tool list, keeping only boolean hints", async () => {
		mocks.listMcpConfigsForTenant.mockResolvedValue([
			config({
				cachedTools: [
					{
						name: "fetch_report",
						annotations: { readOnlyHint: true, title: "ignored" },
					},
					{
						name: "get_everything",
						annotations: { readOnlyHint: "yes" },
					},
					{ name: "plain" },
				],
				toolsCachedAt: new Date(),
			}),
		]);

		const { tools } = await getAggregatedTools(session("user-cached"));

		const byName = new Map(tools.map((tool) => [tool.name, tool]));
		expect(byName.get("example__fetch_report")?.annotations).toEqual({
			readOnlyHint: true,
		});
		expect(
			byName.get("example__get_everything")?.annotations,
		).toBeUndefined();
		expect(byName.get("example__plain")?.annotations).toBeUndefined();
	});

	it("are read from a live discovery and written to the cache", async () => {
		mocks.listMcpConfigsForTenant.mockResolvedValue([config({})]);
		mocks.getCachedMcpClientForConfig.mockResolvedValue({
			client: {
				tools: async () => ({
					fetch_report: {
						description: "Report",
						inputSchema: { jsonSchema: { type: "object" } },
						metadata: { annotations: { readOnlyHint: true } },
					},
				}),
			},
		});

		const { tools } = await getAggregatedTools(session("user-live"));

		expect(
			tools.find((tool) => tool.name === "example__fetch_report")
				?.annotations,
		).toEqual({ readOnlyHint: true });
		expect(mocks.updateMcpConfigToolCache).toHaveBeenCalledWith(
			expect.objectContaining({
				tools: [
					expect.objectContaining({
						name: "fetch_report",
						annotations: { readOnlyHint: true },
					}),
				],
			}),
		);
	});
});
