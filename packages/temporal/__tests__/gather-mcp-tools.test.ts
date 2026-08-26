import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/mcp", () => ({ getCachedMcpClientForConfig: vi.fn() }));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

import { getCachedMcpClientForConfig } from "@repo/mcp";
import { gatherMcpReadOnlyTools } from "../src/activities/template-instance/report-agent-loop";

const mockGetClient = vi.mocked(getCachedMcpClientForConfig);

const base = { userId: "u1", organizationId: "o1", providers: ["github"] };

beforeEach(() => mockGetClient.mockReset());

describe("gatherMcpReadOnlyTools", () => {
	it("returns connected diagnostics + read-only tools on success", async () => {
		mockGetClient.mockResolvedValueOnce({
			serverName: "GitHub",
			client: {
				tools: async () => ({
					list_repos: { description: "d" },
					create_issue: { description: "d" },
				}),
			},
		} as any);
		const { tools, diagnostics } = await gatherMcpReadOnlyTools({
			...base,
			mcpConfigIds: ["c1"],
		});
		expect(Object.keys(tools)).toEqual(["list_repos"]);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({
			serverName: "GitHub",
			outcome: "connected",
			toolCount: 2,
			readOnlyToolCount: 1,
		});
	});

	it("records auth_failed when the client throws an unauthorized error", async () => {
		mockGetClient.mockRejectedValueOnce(new Error("401 Unauthorized"));
		const { tools, diagnostics } = await gatherMcpReadOnlyTools({
			...base,
			mcpConfigIds: ["c1"],
		});
		expect(Object.keys(tools)).toHaveLength(0);
		expect(diagnostics[0]).toMatchObject({
			outcome: "auth_failed",
			configId: "c1",
		});
	});

	it("degrades: one server fails, another succeeds -> tools from the healthy one", async () => {
		mockGetClient
			.mockRejectedValueOnce(new Error("ECONNREFUSED"))
			.mockResolvedValueOnce({
				serverName: "GitHub",
				client: {
					tools: async () => ({ get_release: { description: "d" } }),
				},
			} as any);
		const { tools, diagnostics } = await gatherMcpReadOnlyTools({
			...base,
			mcpConfigIds: ["bad", "good"],
		});
		expect(Object.keys(tools)).toEqual(["get_release"]);
		expect(diagnostics.map((d) => d.outcome)).toEqual([
			"unreachable",
			"connected",
		]);
	});

	it("records no_read_only_tools when server has only write tools", async () => {
		mockGetClient.mockResolvedValueOnce({
			serverName: "GitHub",
			client: {
				tools: async () => ({ create_issue: { description: "d" } }),
			},
		} as any);
		const { tools, diagnostics } = await gatherMcpReadOnlyTools({
			...base,
			mcpConfigIds: ["c1"],
		});
		expect(Object.keys(tools)).toHaveLength(0);
		expect(diagnostics[0]).toMatchObject({
			outcome: "no_read_only_tools",
			toolCount: 1,
			readOnlyToolCount: 0,
		});
	});

	it("records zero_tools when the server exposes no tools", async () => {
		mockGetClient.mockResolvedValueOnce({
			serverName: "Empty",
			client: { tools: async () => ({}) },
		} as any);
		const { tools, diagnostics } = await gatherMcpReadOnlyTools({
			...base,
			mcpConfigIds: ["c1"],
		});
		expect(Object.keys(tools)).toHaveLength(0);
		expect(diagnostics[0]).toMatchObject({
			outcome: "zero_tools",
			toolCount: 0,
			readOnlyToolCount: 0,
		});
	});
});
