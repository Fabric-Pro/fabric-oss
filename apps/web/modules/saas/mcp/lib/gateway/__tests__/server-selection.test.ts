/**
 * Server selection (`?servers=`) below the route: how the parameter is parsed,
 * the one predicate every site asks, how a selection is validated against the
 * caller's connections, and that both executors refuse a tool the session's
 * selection leaves out on their own, for any caller that reaches them without
 * the gateway's tools/call routing. The route's behaviour is pinned in
 * `__tests__/api/mcp-gateway-server-selection.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const listMcpConfigsForTenant = vi.hoisted(() => vi.fn());
const getCachedMcpClientForConfig = vi.hoisted(() => vi.fn());
const findMemberships = vi.hoisted(() => vi.fn());

vi.mock("@repo/api/modules/v1/instruction-direct-repository", () => ({
	getDirectRepositoryState: vi
		.fn()
		.mockResolvedValue({ availability: "UPLOAD", readState: "DIRECT" }),
}));

vi.mock("@repo/database", () => ({
	db: { member: { findMany: findMemberships } },
	listMcpConfigsForTenant,
	// The routing query returns the same rows as the full one here.
	listMcpConfigRoutingForTenant: (...args: unknown[]) =>
		listMcpConfigsForTenant.getMockImplementation()?.(...args),
	updateMcpConfigToolCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@repo/mcp", () => ({
	getCachedMcpClientForConfig,
	invalidateMcpClientCache: vi.fn().mockResolvedValue(undefined),
}));

import { executePlatformTool } from "../platform-tools";
import {
	parseServerSelection,
	selectionAllowsTool,
	selectionIncludesServer,
	unknownServerNames,
} from "../server-selection";
import {
	executeConnectedServerTool,
	validateServerSelection,
} from "../tool-aggregator";
import type {
	ConnectedServerInfo,
	GatewaySession,
	ServerSelection,
} from "../types";

function session(overrides: Partial<GatewaySession> = {}): GatewaySession {
	return {
		sessionId: "session-1",
		userId: "user-selection-unit",
		organizationId: "org-example-alpha",
		projectId: null,
		userName: "Dev",
		email: "dev@example.com",
		role: "user",
		credential: "personal-key",
		scopes: ["*"],
		createdAt: new Date("2026-10-04T12:00:00Z"),
		expiresAt: new Date("2026-10-05T12:00:00Z"),
		...overrides,
	};
}

const LINEAR: ConnectedServerInfo = {
	configId: "config-linear",
	displayName: "Linear",
	toolPrefix: "linear",
	tools: [{ name: "list_issues" }, { name: "create_issue" }],
};

const whole = (server: string) => ({ server, tools: "*" as const });

let ownerCounter = 0;
/** A fresh person per validation, so the aggregator's per-user cache never carries over. */
function owner() {
	ownerCounter += 1;
	return {
		userId: `user-validate-${ownerCounter}`,
		organizationId: "org-example-alpha",
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("parseServerSelection", () => {
	const parse = (query: string) =>
		parseServerSelection(new URLSearchParams(query));

	it("reads an absent parameter as every server", () => {
		expect(parse("")).toEqual({ kind: "all" });
	});

	it("trims, lowercases and collapses duplicates, keeping first-seen order", () => {
		expect(parse("servers= Fabric ,GitHub_2,fabric")).toEqual({
			kind: "entries",
			entries: [whole("fabric"), whole("github_2")],
		});
	});

	it("reads a repeated parameter as one list", () => {
		expect(parse("servers=fabric&servers=linear")).toEqual({
			kind: "entries",
			entries: [whole("fabric"), whole("linear")],
		});
	});

	it("reads name:* as the whole server", () => {
		expect(parse("servers=linear:*")).toEqual({
			kind: "entries",
			entries: [whole("linear")],
		});
	});

	it("unions the tools named for one server and collapses duplicates", () => {
		expect(
			parse(
				"servers=fizzy:fizzy_get_cards,fizzy:fizzy_create_card,fizzy:fizzy_get_cards",
			),
		).toEqual({
			kind: "entries",
			entries: [
				{
					server: "fizzy",
					tools: ["fizzy_get_cards", "fizzy_create_card"],
				},
			],
		});
	});

	it.each([
		["name before name:tool", "servers=fizzy,fizzy:fizzy_get_cards"],
		["name:tool before name", "servers=fizzy:fizzy_get_cards,fizzy"],
		["name:tool before name:*", "servers=fizzy:fizzy_get_cards,fizzy:*"],
	])("reads %s as the whole server", (_label, query) => {
		expect(parse(query)).toEqual({
			kind: "entries",
			entries: [whole("fizzy")],
		});
	});

	it("lowercases and trims the server part and keeps the tool part's case", () => {
		expect(parse("servers= Fizzy : Fizzy_Get_Cards ")).toEqual({
			kind: "entries",
			entries: [{ server: "fizzy", tools: ["Fizzy_Get_Cards"] }],
		});
	});

	it.each([
		["a present but empty value", "servers="],
		["a blank value", "servers=%20"],
		["an empty entry", "servers=fabric,,linear"],
		["a trailing comma", "servers=fabric,"],
		["an empty tool part", "servers=fizzy:"],
		["a blank tool part", "servers=fizzy:%20"],
		["an empty server part", "servers=:fizzy_get_cards"],
	])("refuses %s", (_label, query) => {
		expect(parse(query)).toMatchObject({ kind: "invalid" });
	});
});

describe("unknownServerNames", () => {
	it("accepts fabric and the given prefixes, and returns the rest", () => {
		expect(
			unknownServerNames(
				[
					whole("fabric"),
					whole("linear"),
					{ server: "jira", tools: ["x"] },
				],
				["linear"],
			),
		).toEqual(["jira"]);
	});
});

describe("selectionAllowsTool", () => {
	const select = (serverSelection: ServerSelection) => ({ serverSelection });

	it("allows everything without a selection", () => {
		for (const serverSelection of [undefined, null]) {
			const wide = { serverSelection };
			expect(selectionAllowsTool(wide, "fabric_list_projects")).toBe(
				true,
			);
			expect(selectionAllowsTool(wide, "linear__list_issues")).toBe(true);
		}
	});

	it("classifies a name as the tools/call routing does", () => {
		const onlyLinear = select([whole("linear")]);
		expect(selectionAllowsTool(onlyLinear, "fabric_list_projects")).toBe(
			false,
		);
		expect(selectionAllowsTool(onlyLinear, "linear__list_issues")).toBe(
			true,
		);
		expect(selectionAllowsTool(onlyLinear, "linear_2__list_issues")).toBe(
			false,
		);
		// The text before the FIRST separator is the prefix, as in
		// executeConnectedServerTool, so a tool name with its own `__` cannot
		// borrow a selected prefix.
		expect(selectionAllowsTool(onlyLinear, "github__linear__x")).toBe(
			false,
		);
		// Neither form: nothing would run it, and the caller says "unknown".
		expect(selectionAllowsTool(onlyLinear, "list_issues")).toBe(true);
	});

	it("keeps only the named tools of a server, by the server's own tool name", () => {
		const oneTool = select([{ server: "linear", tools: ["list_issues"] }]);
		expect(selectionAllowsTool(oneTool, "linear__list_issues")).toBe(true);
		expect(selectionAllowsTool(oneTool, "linear__create_issue")).toBe(
			false,
		);
		// Case-sensitive, as tool names are.
		expect(selectionAllowsTool(oneTool, "linear__List_Issues")).toBe(false);
		// Everything after the first `__` is the tool name.
		expect(
			selectionAllowsTool(
				select([{ server: "linear", tools: ["a__b"] }]),
				"linear__a__b",
			),
		).toBe(true);
	});

	it("keeps a named platform tool by its full name", () => {
		const onePlatform = select([
			{ server: "fabric", tools: ["fabric_get_identity"] },
		]);
		expect(selectionAllowsTool(onePlatform, "fabric_get_identity")).toBe(
			true,
		);
		expect(selectionAllowsTool(onePlatform, "fabric_list_projects")).toBe(
			false,
		);
	});
});

describe("selectionIncludesServer", () => {
	it("includes a server named wholly or by some of its tools", () => {
		const selection = {
			serverSelection: [
				whole("github"),
				{ server: "linear", tools: ["list_issues"] },
			],
		};
		expect(selectionIncludesServer(selection, "github")).toBe(true);
		expect(selectionIncludesServer(selection, "linear")).toBe(true);
		expect(selectionIncludesServer(selection, "fizzy")).toBe(false);
	});
});

describe("validateServerSelection", () => {
	const configs = [
		{
			id: "a",
			enabled: true,
			displayName: "GitHub",
			cachedTools: [{ name: "list_repos" }],
			toolsCachedAt: new Date(),
		},
		{
			id: "b",
			enabled: true,
			displayName: "GitHub",
			cachedTools: [{ name: "list_repos" }],
			toolsCachedAt: new Date(),
		},
		{
			id: "c",
			enabled: false,
			displayName: "Linear",
			cachedTools: [{ name: "list_issues" }],
			toolsCachedAt: new Date(),
		},
		{
			id: "d",
			enabled: true,
			displayName: null,
			mcpServer: { name: "My Notes!" },
			cachedTools: null,
			toolsCachedAt: null,
		},
	];

	it("accepts servers named as the aggregator names them, without discovering tools", async () => {
		listMcpConfigsForTenant.mockResolvedValue(configs);

		expect(
			await validateServerSelection(owner(), [
				whole("fabric"),
				whole("github"),
				whole("github_2"),
				whole("my_notes"),
			]),
		).toEqual({ ok: true });
		expect(getCachedMcpClientForConfig).not.toHaveBeenCalled();
	});

	it("refuses a disabled connection's name, listing the valid names", async () => {
		listMcpConfigsForTenant.mockResolvedValue(configs);

		const result = await validateServerSelection(owner(), [
			whole("linear"),
		]);
		expect(result).toMatchObject({ ok: false });
		expect(!result.ok && result.message).toContain(
			"Valid names for this connection: fabric, github, github_2, my_notes.",
		);
	});

	it("refuses a platform tool that does not exist and accepts one that does", async () => {
		listMcpConfigsForTenant.mockResolvedValue([]);

		expect(
			await validateServerSelection(owner(), [
				{ server: "fabric", tools: ["fabric_get_identity"] },
			]),
		).toEqual({ ok: true });

		const result = await validateServerSelection(owner(), [
			{ server: "fabric", tools: ["fabric_get_identity", "fabric_nope"] },
		]);
		expect(result).toMatchObject({ ok: false });
		expect(!result.ok && result.message).toContain("fabric:fabric_nope");
		expect(!result.ok && result.message).not.toContain(
			"fabric:fabric_get_identity",
		);
	});

	it("refuses an unknown tool of a server whose tools were discovered", async () => {
		listMcpConfigsForTenant.mockResolvedValue(configs);

		const result = await validateServerSelection(owner(), [
			{ server: "github_2", tools: ["list_repos", "delete_repo"] },
		]);
		expect(result).toMatchObject({ ok: false });
		expect(!result.ok && result.message).toContain("github_2:delete_repo");
		expect(!result.ok && result.message).toContain(
			"Its tools are: list_repos.",
		);
	});

	it("counts a long tool list instead of printing it", async () => {
		listMcpConfigsForTenant.mockResolvedValue([
			{
				id: "big",
				enabled: true,
				displayName: "Big",
				cachedTools: Array.from({ length: 40 }, (_, i) => ({
					name: `tool_${i}`,
				})),
				toolsCachedAt: new Date(),
			},
		]);

		const result = await validateServerSelection(owner(), [
			{ server: "big", tools: ["nope"] },
		]);
		expect(!result.ok && result.message).toContain("It has 40 tools");
		expect(!result.ok && result.message).not.toContain("tool_39");
	});

	it("accepts a tool of a server whose tools cannot be discovered right now", async () => {
		listMcpConfigsForTenant.mockResolvedValue(configs);
		getCachedMcpClientForConfig.mockRejectedValue(new Error("unreachable"));

		expect(
			await validateServerSelection(owner(), [
				{ server: "my_notes", tools: ["search"] },
			]),
		).toEqual({ ok: true });
		expect(getCachedMcpClientForConfig).toHaveBeenCalled();
	});
});

describe("validateServerSelection after a rename, with a cached list", () => {
	const github = (id: string, displayName: string, tool: string) => ({
		id,
		enabled: true,
		displayName,
		cachedTools: [{ name: tool }],
		toolsCachedAt: new Date(),
	});

	it("follows the connections as they are now, as tools/call routes, not a cached mapping", async () => {
		const person = owner();
		// Cached: `github` is connection A, `github_2` is connection B.
		listMcpConfigsForTenant.mockResolvedValue([
			github("config-a", "GitHub", "a_tool"),
			github("config-b", "GitHub", "b_tool"),
		]);
		expect(
			await validateServerSelection(person, [
				{ server: "github_2", tools: ["b_tool"] },
			]),
		).toEqual({ ok: true });

		// A is renamed, so the records now give `github` to B. The cached list
		// is not reused for a mapping that has changed (Fizzy #3024).
		listMcpConfigsForTenant.mockResolvedValue([
			github("config-a", "Archive", "a_tool"),
			github("config-b", "GitHub", "b_tool"),
		]);

		expect(
			await validateServerSelection(person, [
				{ server: "github", tools: ["b_tool"] },
			]),
		).toEqual({ ok: true });
		expect(
			await validateServerSelection(person, [
				{ server: "github", tools: ["a_tool"] },
			]),
		).toMatchObject({ ok: false });
	});

	it("still refuses an unknown tool when the cache and the records agree (the control)", async () => {
		const person = owner();
		listMcpConfigsForTenant.mockResolvedValue([
			github("config-a", "GitHub", "a_tool"),
		]);
		await validateServerSelection(person, [whole("github")]);

		const result = await validateServerSelection(person, [
			{ server: "github", tools: ["b_tool"] },
		]);
		expect(result).toMatchObject({ ok: false });
	});
});

describe("executeConnectedServerTool on its own", () => {
	it("refuses a server the selection leaves out without contacting its upstream", async () => {
		const result = await executeConnectedServerTool(
			"linear__list_issues",
			{},
			session({ serverSelection: [whole("fabric")] }),
			[LINEAR],
		);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain(
			"linear__list_issues is not available on this connection",
		);
		expect(getCachedMcpClientForConfig).not.toHaveBeenCalled();
	});

	it("refuses a deselected tool of a selected server without contacting its upstream", async () => {
		const result = await executeConnectedServerTool(
			"linear__create_issue",
			{},
			session({
				serverSelection: [{ server: "linear", tools: ["list_issues"] }],
			}),
			[LINEAR],
		);

		expect(result.isError).toBe(true);
		expect(getCachedMcpClientForConfig).not.toHaveBeenCalled();
	});

	it("contacts a selected tool's upstream (the control)", async () => {
		getCachedMcpClientForConfig.mockResolvedValue({
			client: {
				tools: async () => ({
					list_issues: { execute: async () => ({ content: [] }) },
				}),
			},
		});

		await executeConnectedServerTool(
			"linear__list_issues",
			{},
			session({
				serverSelection: [{ server: "linear", tools: ["list_issues"] }],
			}),
			[LINEAR],
		);

		expect(getCachedMcpClientForConfig).toHaveBeenCalledTimes(1);
	});
});

describe("executePlatformTool on its own", () => {
	it("refuses a platform tool when the selection leaves fabric out", async () => {
		const result = await executePlatformTool(
			"fabric_get_identity",
			{},
			session({ serverSelection: [whole("linear")] }),
		);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain(
			"fabric_get_identity is not available on this connection",
		);
	});

	it("refuses a platform tool that fabric's named tools leave out", async () => {
		const result = await executePlatformTool(
			"fabric_get_identity",
			{},
			session({
				serverSelection: [
					{ server: "fabric", tools: ["fabric_list_projects"] },
				],
			}),
		);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain(
			"not available on this connection",
		);
	});

	it("runs it when it is selected (the control)", async () => {
		findMemberships.mockResolvedValueOnce([
			{
				role: "member",
				organization: {
					id: "org-example-alpha",
					name: "Example Alpha",
					slug: "example-alpha",
				},
			},
		]);
		const result = await executePlatformTool(
			"fabric_get_identity",
			{},
			session({
				serverSelection: [
					{ server: "fabric", tools: ["fabric_get_identity"] },
				],
			}),
		);

		expect(result.isError).not.toBe(true);
		expect(JSON.parse(result.content[0].text)).toMatchObject({
			userId: "user-selection-unit",
			organizationName: "Example Alpha",
		});
	});
});
