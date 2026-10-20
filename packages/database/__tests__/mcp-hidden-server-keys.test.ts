import { beforeEach, describe, expect, it, vi } from "vitest";

const mCPServerFindManyMock = vi.fn();
const mCPConfigFindManyMock = vi.fn();

vi.mock("../prisma/client", () => ({
	db: {
		mCPServer: {
			findMany: (...args: unknown[]) => mCPServerFindManyMock(...args),
		},
		mCPConfig: {
			findMany: (...args: unknown[]) => mCPConfigFindManyMock(...args),
		},
	},
}));

import { RETIRED_SYSTEM_MCP_SERVER_KEYS } from "../prisma/curated-mcp-server-keys";
import {
	HIDDEN_SYSTEM_MCP_SERVER_KEYS,
	isHiddenSystemMcpServerKey,
	withoutHiddenSystemMcpServers,
} from "../prisma/hidden-mcp-server-keys";
import {
	getAvailableMcpConfigsForKeys,
	listMcpServersAccessibleToTenant,
	listSystemMcpServers,
} from "../prisma/queries/mcp";

describe("MCP Hidden Server Keys & Config Resolution", () => {
	beforeEach(() => {
		mCPServerFindManyMock.mockReset();
		mCPConfigFindManyMock.mockReset();
	});

	it("includes retired keys in both the exported hidden list and its predicate", () => {
		expect(HIDDEN_SYSTEM_MCP_SERVER_KEYS).toContain("github");
		expect(isHiddenSystemMcpServerKey("github")).toBe(true);
		for (const key of RETIRED_SYSTEM_MCP_SERVER_KEYS) {
			expect(HIDDEN_SYSTEM_MCP_SERVER_KEYS).toContain(key);
			expect(isHiddenSystemMcpServerKey(key)).toBe(true);
		}
	});

	it.each(["upstash", "browserbase"])(
		"retires %s while keeping it hidden",
		(key) => {
			expect(RETIRED_SYSTEM_MCP_SERVER_KEYS).toContain(key);
			expect(isHiddenSystemMcpServerKey(key)).toBe(true);
		},
	);

	it("lists each hidden key once", () => {
		expect(new Set(HIDDEN_SYSTEM_MCP_SERVER_KEYS).size).toBe(
			HIDDEN_SYSTEM_MCP_SERVER_KEYS.length,
		);
	});

	it("keeps rebuilt entries hidden while Cloudflare remains available", () => {
		for (const key of [
			"neon",
			"axiom",
			"airtable",
			"todoist",
			"brave-search",
			"memory",
			"sequential-thinking",
			"everything",
		]) {
			expect(isHiddenSystemMcpServerKey(key)).toBe(true);
		}
		expect(isHiddenSystemMcpServerKey("cloudflare")).toBe(false);
	});

	it("existing configurations for hidden servers still resolve in getAvailableMcpConfigsForKeys", async () => {
		mCPConfigFindManyMock.mockResolvedValue([
			{
				id: "cfg_seq_1",
				displayName: "My Sequential Thinking",
				enabled: true,
				mcpServer: {
					id: "server_seq_1",
					key: "sequential-thinking",
					name: "Sequential Thinking",
					isSystemProvided: true,
					iconUrl: null,
				},
			},
		]);

		const result = await getAvailableMcpConfigsForKeys({
			keys: ["sequential-thinking"],
			userId: "user_1",
			organizationId: "org_1",
		});

		expect(result).toHaveLength(1);
		expect(result[0]?.key).toBe("sequential-thinking");
		expect(result[0]?.configs).toHaveLength(1);
		expect(result[0]?.configs[0]?.configId).toBe("cfg_seq_1");
		expect(result[0]?.configs[0]?.configName).toBe(
			"My Sequential Thinking",
		);
	});

	it("listSystemMcpServers queries with hidden keys excluded", async () => {
		mCPServerFindManyMock.mockResolvedValue([]);

		await listSystemMcpServers();

		expect(mCPServerFindManyMock).toHaveBeenCalledWith({
			where: {
				isSystemProvided: true,
				isImplemented: true,
				key: { notIn: [...HIDDEN_SYSTEM_MCP_SERVER_KEYS] },
			},
			orderBy: { name: "asc" },
		});
	});

	it("listMcpServersAccessibleToTenant excludes hidden keys for system servers but preserves tenant conditions", async () => {
		mCPServerFindManyMock.mockResolvedValue([]);

		await listMcpServersAccessibleToTenant({
			userId: "user_1",
			organizationId: "org_1",
			includeNonImplemented: true,
		});

		expect(mCPServerFindManyMock).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					OR: [
						{
							isSystemProvided: true,
							key: { notIn: [...HIDDEN_SYSTEM_MCP_SERVER_KEYS] },
						},
						{ userId: "user_1", organizationId: "org_1" },
					],
				},
			}),
		);
	});

	it("listMcpServersAccessibleToTenant with includeNonImplemented: false excludes hidden keys and requires isImplemented", async () => {
		mCPServerFindManyMock.mockResolvedValue([]);

		await listMcpServersAccessibleToTenant({
			userId: "user_1",
			organizationId: "org_1",
			includeNonImplemented: false,
		});

		expect(mCPServerFindManyMock).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					OR: [
						{
							isSystemProvided: true,
							isImplemented: true,
							key: { notIn: [...HIDDEN_SYSTEM_MCP_SERVER_KEYS] },
						},
						{ userId: "user_1", organizationId: "org_1" },
					],
				},
			}),
		);
	});

	describe("withoutHiddenSystemMcpServers", () => {
		it("filters retired system rows from cached listings but preserves tenant-owned rows", () => {
			const custom = { key: "github", isSystemProvided: false };
			expect(
				withoutHiddenSystemMcpServers([
					{ key: "github", isSystemProvided: true },
					custom,
				]),
			).toEqual([custom]);
		});

		it("drops a system server whose key is memory", () => {
			const servers = [
				{ key: "memory", isSystemProvided: true, name: "Memory" },
			];
			expect(withoutHiddenSystemMcpServers(servers)).toEqual([]);
		});

		it("drops newly hidden system servers such as sqlite and fetch", () => {
			const servers = [
				{ key: "sqlite", isSystemProvided: true, name: "SQLite" },
				{ key: "fetch", isSystemProvided: true, name: "Fetch" },
				{ key: "fabric", isSystemProvided: true, name: "Fabric MCP" },
			];
			expect(withoutHiddenSystemMcpServers(servers)).toEqual([]);
		});

		it("keeps a tenant server (isSystemProvided: false) with key memory", () => {
			const servers = [
				{
					key: "memory",
					isSystemProvided: false,
					name: "Custom Memory",
				},
			];
			expect(withoutHiddenSystemMcpServers(servers)).toEqual(servers);
		});

		it("keeps system servers with non-hidden keys", () => {
			const servers = [
				{
					key: "github-remote",
					isSystemProvided: true,
					name: "GitHub",
				},
				{ key: "linear", isSystemProvided: true, name: "Linear" },
			];
			expect(withoutHiddenSystemMcpServers(servers)).toEqual(servers);
		});

		it("keeps a system server with key twilio", () => {
			const servers = [
				{ key: "twilio", isSystemProvided: true, name: "Twilio" },
			];
			expect(withoutHiddenSystemMcpServers(servers)).toEqual(servers);
		});
	});
});
