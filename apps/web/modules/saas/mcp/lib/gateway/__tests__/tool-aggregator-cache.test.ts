/**
 * The aggregator's cached tool list is reused only while the connections still
 * map the same tool prefixes to the same connections (Fizzy #3024).
 *
 * `tools/call` routes through the cached `servers`, so a rename, add, removal,
 * enable or disable has to show on the next request, not after the cache's
 * five-minute lifetime. The module-level cache outlives a test, so each test
 * uses its own user and organization.
 */

import { Console } from "node:console";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listMcpConfigsForTenant: vi.fn(),
	listMcpConfigRoutingForTenant: vi.fn(),
	updateMcpConfigToolCache: vi.fn(),
	getCachedMcpClientForConfig: vi.fn(),
	invalidateMcpClientCache: vi.fn(),
}));

vi.mock("@repo/api/modules/v1/instruction-direct-repository", () => ({
	getDirectRepositoryState: vi
		.fn()
		.mockResolvedValue({ availability: "UPLOAD", readState: "DIRECT" }),
}));

vi.mock("@repo/database", () => ({
	listMcpConfigsForTenant: mocks.listMcpConfigsForTenant,
	listMcpConfigRoutingForTenant: mocks.listMcpConfigRoutingForTenant,
	updateMcpConfigToolCache: mocks.updateMcpConfigToolCache,
}));

vi.mock("@repo/mcp", () => ({
	getCachedMcpClientForConfig: mocks.getCachedMcpClientForConfig,
	invalidateMcpClientCache: mocks.invalidateMcpClientCache,
}));

import {
	executeConnectedServerTool,
	getAggregatedTools,
} from "../tool-aggregator";
import type { GatewaySession } from "../types";

function session(n: string): GatewaySession {
	return {
		sessionId: `session-${n}`,
		userId: `user-cache-${n}`,
		organizationId: `org-example-cache-${n}`,
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

type Row = ReturnType<typeof connection>;

function connection(
	id: string,
	displayName: string,
	tool: string,
	enabled = true,
) {
	return {
		id,
		displayName,
		enabled,
		mcpServer: { name: "Example Server" },
		cachedTools: [{ name: tool }],
		toolsCachedAt: new Date(),
	};
}

/** Both queries answer from the same rows, as they do from one table. */
function setRows(rows: Row[]) {
	mocks.listMcpConfigsForTenant.mockResolvedValue(rows);
	mocks.listMcpConfigRoutingForTenant.mockResolvedValue(
		rows.map(({ id, enabled, displayName, mcpServer }) => ({
			id,
			enabled,
			displayName,
			mcpServer,
		})),
	);
}

const toolNames = (tools: Array<{ name: string }>) =>
	tools.map((tool) => tool.name);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.updateMcpConfigToolCache.mockResolvedValue({});
	mocks.invalidateMcpClientCache.mockResolvedValue(undefined);
	mocks.getCachedMcpClientForConfig.mockResolvedValue({
		client: {
			tools: async () => ({
				list: { execute: async () => ({ content: [] }) },
			}),
		},
	});
});

afterEach(() => vi.restoreAllMocks());

describe("upstream failure logs", () => {
	for (const path of ["discovery", "execution"] as const) {
		it.each(["thrown string", "Error", "ordinary Error"])(
			`${path} escapes controls from an upstream %s and keeps diagnostics`,
			async (kind) => {
				const message =
					kind === "ordinary Error"
						? "upstream unavailable"
						: "upstream\r\nFORGED\u001b[31m";
				const failure =
					kind === "thrown string" ? message : new Error(message);
				if (failure instanceof Error) {
					failure.stack = `Error: ${message}\n    at upstream (example.ts:1:1)`;
				}
				let output = "";
				const stream = new Writable({
					write(chunk, _encoding, callback) {
						output += chunk.toString();
						callback();
					},
				});
				const captured = new Console({
					stdout: stream,
					stderr: stream,
					inspectOptions: {
						breakLength: Number.POSITIVE_INFINITY,
						compact: true,
					},
				});
				vi.spyOn(console, "warn").mockImplementation(
					captured.warn.bind(captured),
				);
				vi.spyOn(console, "error").mockImplementation(
					captured.error.bind(captured),
				);
				const s = session(`log-${path}-${kind}`);
				mocks.getCachedMcpClientForConfig.mockRejectedValue(failure);

				if (path === "discovery") {
					mocks.listMcpConfigsForTenant.mockResolvedValue([
						{
							...connection("config-a", "Example", "list"),
							cachedTools: null,
							toolsCachedAt: null,
						},
					]);
					expect((await getAggregatedTools(s)).servers).toEqual([]);
				} else {
					const result = await executeConnectedServerTool(
						"example__list",
						{},
						s,
						[
							{
								configId: "config-a",
								displayName: "Example",
								toolPrefix: "example",
								tools: [{ name: "list" }],
							},
						],
					);
					expect(result.isError).toBe(true);
				}

				expect(output.trimEnd().split("\n")).toHaveLength(1);
				expect(output).not.toContain("\r");
				expect(output).not.toContain("\u001b");
				expect(output).toContain(
					kind === "ordinary Error"
						? message
						: "upstream\\r\\nFORGED\\x1B[31m",
				);
				if (failure instanceof Error) {
					expect(output).toContain("at upstream (example.ts:1:1)");
				}
			},
		);
	}
});

describe("a renamed connection inside the cache lifetime", () => {
	it("routes the prefix to the connection that now has the name, in the list and on a call", async () => {
		const s = session("rename");
		// A was created later, so it gets `github`; B gets `github_2`.
		setRows([
			connection("config-a", "GitHub", "list"),
			connection("config-b", "GitHub", "list"),
		]);
		const first = await getAggregatedTools(s);
		expect(first.servers.map((x) => [x.toolPrefix, x.configId])).toEqual([
			["github", "config-a"],
			["github_2", "config-b"],
		]);

		setRows([
			connection("config-a", "Old", "list"),
			connection("config-b", "GitHub", "list"),
		]);
		const second = await getAggregatedTools(s);

		expect(second.servers.map((x) => [x.toolPrefix, x.configId])).toEqual([
			["old", "config-a"],
			["github", "config-b"],
		]);
		const listed = second.tools.find(
			(tool) => tool.name === "github__list",
		);
		expect(listed?._gateway_config_id).toBe("config-b");

		await executeConnectedServerTool("github__list", {}, s, second.servers);
		expect(mocks.getCachedMcpClientForConfig).toHaveBeenCalledWith(
			expect.objectContaining({ configId: "config-b" }),
		);
	});
});

describe("a connection added, removed or disabled inside the cache lifetime", () => {
	it("lists an added connection's tools", async () => {
		const s = session("add");
		setRows([connection("config-a", "Alpha", "one")]);
		expect(toolNames((await getAggregatedTools(s)).tools)).not.toContain(
			"beta__two",
		);

		setRows([
			connection("config-b", "Beta", "two"),
			connection("config-a", "Alpha", "one"),
		]);
		const names = toolNames((await getAggregatedTools(s)).tools);

		expect(names).toContain("alpha__one");
		expect(names).toContain("beta__two");
	});

	it("drops a disabled connection's tools", async () => {
		const s = session("disable");
		setRows([
			connection("config-a", "Alpha", "one"),
			connection("config-b", "Beta", "two"),
		]);
		expect(toolNames((await getAggregatedTools(s)).tools)).toContain(
			"beta__two",
		);

		setRows([
			connection("config-a", "Alpha", "one"),
			connection("config-b", "Beta", "two", false),
		]);
		const { tools, servers } = await getAggregatedTools(s);

		expect(toolNames(tools)).not.toContain("beta__two");
		expect(toolNames(tools)).toContain("alpha__one");
		expect(servers.map((x) => x.configId)).toEqual(["config-a"]);
	});

	it("drops a removed connection's tools", async () => {
		const s = session("remove");
		setRows([
			connection("config-a", "Alpha", "one"),
			connection("config-b", "Beta", "two"),
		]);
		await getAggregatedTools(s);

		setRows([connection("config-a", "Alpha", "one")]);
		const { tools } = await getAggregatedTools(s);

		expect(toolNames(tools)).not.toContain("beta__two");
	});
});

describe("an unchanged mapping inside the cache lifetime", () => {
	it("uses the cached list, checking only the routing rows", async () => {
		const s = session("unchanged");
		setRows([connection("config-a", "Alpha", "one")]);

		const first = await getAggregatedTools(s);
		expect(mocks.listMcpConfigRoutingForTenant).not.toHaveBeenCalled();
		const second = await getAggregatedTools(s);

		expect(second.tools).toBe(first.tools);
		expect(mocks.listMcpConfigsForTenant).toHaveBeenCalledOnce();
		expect(mocks.listMcpConfigRoutingForTenant).toHaveBeenCalledOnce();
		expect(mocks.listMcpConfigRoutingForTenant).toHaveBeenCalledWith({
			userId: s.userId,
			organizationId: s.organizationId,
		});
	});
});

describe("a failing routing query", () => {
	it("rejects instead of serving the cached list", async () => {
		const s = session("failing");
		setRows([connection("config-a", "Alpha", "one")]);
		await getAggregatedTools(s);

		mocks.listMcpConfigRoutingForTenant.mockRejectedValue(
			new Error("database unavailable"),
		);

		await expect(getAggregatedTools(s)).rejects.toThrow(
			"database unavailable",
		);
	});
});
