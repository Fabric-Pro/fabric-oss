/**
 * Tests for MCP Gateway security hardening, OAuth agent human-approved write
 * authority, protocol compliance, rich result preservation, and Composio v3 /
 * Rube discovery parity.
 */

import { authorityRequestFingerprint } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	classifyAccessLevel,
	classifyConnectedToolAccess,
	generateRequestFingerprint,
} from "../authority-service";
import {
	getToolSchema,
	MANAGE_CONNECTIONS_NAME,
	MULTI_EXECUTE_TOOL_NAME,
	parseMultiExecuteArguments,
	searchTools,
} from "../discovery-tools";
import { parseMcpToolResult } from "../tool-aggregator";
import { scopeSatisfied } from "../tool-scope";
import type { GatewaySession, GatewayToolDefinition } from "../types";

const dbMocks = vi.hoisted(() => ({
	checkAuthority: vi.fn(),
	consumeRequestGrant: vi.fn(),
	createAuthorityRequest: vi.fn(),
	createProject: vi.fn(),
	getAuthoritySession: vi.fn(),
	revokeAuthoritySession: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	return {
		...actual,
		checkAuthority: (...args: unknown[]) => dbMocks.checkAuthority(...args),
		consumeRequestGrant: (...args: unknown[]) =>
			dbMocks.consumeRequestGrant(...args),
		createAuthorityRequest: (...args: unknown[]) =>
			dbMocks.createAuthorityRequest(...args),
		createProject: (...args: unknown[]) => dbMocks.createProject(...args),
		getAuthoritySession: (...args: unknown[]) =>
			dbMocks.getAuthoritySession(...args),
		revokeAuthoritySession: (...args: unknown[]) =>
			dbMocks.revokeAuthoritySession(...args),
	};
});

function makeOAuthSession(overrides?: Partial<GatewaySession>): GatewaySession {
	return {
		sessionId: "sess-oauth-1",
		userId: "user-example-1",
		organizationId: "org-example-1",
		projectId: null,
		userName: "Example User",
		email: "dev@example.com",
		role: "user",
		credential: "oauth",
		scopes: ["mcp:read"],
		createdAt: new Date("2026-11-01T00:00:00Z"),
		expiresAt: new Date("2026-11-02T00:00:00Z"),
		...overrides,
	};
}

describe("1. OAuth agent human-approved write authority", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("allows OAuth agents holding mcp:read to satisfy mcp:write scope (for authority tools & connected server writes)", () => {
		expect(
			scopeSatisfied(
				["mcp:read"],
				{ scope: "mcp:write", kind: "write" },
				"oauth",
			),
		).toBe(true);
		// Organization API keys holding only mcp:read still require explicit mcp:write
		expect(
			scopeSatisfied(
				["mcp:read"],
				{ scope: "mcp:write", kind: "write" },
				"organization-key",
			),
		).toBe(false);
	});

	it("refuses Fabric platform write tools to an OAuth agent without an approved runtime authority grant, and hints fabric_request_authority", async () => {
		dbMocks.checkAuthority.mockResolvedValue({
			authorized: false,
			reason: "No active authority grant",
		});

		const { executePlatformTool } = await import("../platform-tools");
		const result = await executePlatformTool(
			"fabric_update_project",
			{ projectId: "proj-1", name: "Renamed" },
			makeOAuthSession(),
		);

		expect(result.isError).toBe(true);
		const errorPayload = JSON.parse(result.content[0]?.text ?? "{}") as {
			error?: string;
		};
		expect(errorPayload.error).toContain(
			'does not have the "projects:write" scope required by fabric_update_project',
		);
		expect(errorPayload.error).toContain("fabric_request_authority");
		expect(dbMocks.checkAuthority).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-example-1",
				organizationId: "org-example-1",
				providerKey: "fabric",
				accessLevel: "WRITE",
				toolName: "fabric_update_project",
				boundRunType: "MCP_GATEWAY",
				boundRunId: "sess-oauth-1",
			}),
		);
	});

	it("prevents read-only OAuth callers from revoking authority sessions belonging to other runs or gateway sessions", async () => {
		dbMocks.getAuthoritySession.mockResolvedValue({
			id: "auth-sess-other",
			status: "ACTIVE",
			runType: "WORKFLOW",
			runId: "wf-123",
		});

		const { executePlatformTool } = await import("../platform-tools");
		const denied = await executePlatformTool(
			"fabric_revoke_authority",
			{ sessionId: "auth-sess-other" },
			makeOAuthSession(),
		);
		expect(denied.isError).toBe(true);
		expect(dbMocks.revokeAuthoritySession).not.toHaveBeenCalled();

		// Own gateway session is allowed
		dbMocks.getAuthoritySession.mockResolvedValue({
			id: "auth-sess-own",
			status: "ACTIVE",
			runType: "MCP_GATEWAY",
			runId: "sess-oauth-1",
		});
		dbMocks.revokeAuthoritySession.mockResolvedValue({
			transitioned: true,
			previousStatus: "ACTIVE",
		});
		const allowed = await executePlatformTool(
			"fabric_revoke_authority",
			{ sessionId: "auth-sess-own" },
			makeOAuthSession(),
		);
		expect(allowed.isError).toBeUndefined();
		expect(dbMocks.revokeAuthoritySession).toHaveBeenCalledTimes(1);
	});

	it("consumes a one-shot REQUEST grant atomically for an OAuth agent and blocks concurrent replay", async () => {
		dbMocks.checkAuthority.mockResolvedValue({
			authorized: true,
			grant: {
				id: "grant-req-1",
				kind: "REQUEST",
				accessLevel: "WRITE",
				expiresAt: new Date(Date.now() + 60_000),
				providerKey: "fabric",
				sessionId: "auth-sess-1",
			},
		});
		// Simulate a concurrent request having already consumed the one-shot grant
		dbMocks.consumeRequestGrant.mockResolvedValue({
			consumed: false,
			count: 0,
		});

		const { executePlatformTool } = await import("../platform-tools");
		const result = await executePlatformTool(
			"fabric_update_project",
			{ projectId: "proj-1", name: "Renamed" },
			makeOAuthSession(),
		);

		expect(dbMocks.consumeRequestGrant).toHaveBeenCalledWith("grant-req-1");
		expect(result.isError).toBe(true);
	});

	it("sets FABRIC_NATIVE providerType when requesting authority for providerKey 'fabric'", async () => {
		dbMocks.createAuthorityRequest.mockResolvedValue({
			session: {
				id: "auth-sess-fabric",
				status: "PENDING",
				expiresAt: new Date(Date.now() + 1800_000),
			},
			grants: [
				{
					id: "grant-1",
					providerKey: "fabric",
					accessLevel: "WRITE",
					status: "PENDING",
				},
			],
		});

		const { executePlatformTool } = await import("../platform-tools");
		const result = await executePlatformTool(
			"fabric_request_authority",
			{
				providers: [
					{
						providerKey: "fabric",
						accessLevel: "WRITE",
						reason: "Create stories in project",
					},
					{
						providerKey: "github",
						accessLevel: "WRITE",
						reason: "Open PR",
					},
				],
			},
			makeOAuthSession(),
		);

		expect(result.isError).toBeUndefined();
		expect(dbMocks.createAuthorityRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				grants: [
					expect.objectContaining({
						providerType: "FABRIC_NATIVE",
						providerKey: "fabric",
						providerDisplayName: "Fabric Platform",
						accessLevel: "WRITE",
					}),
					expect.objectContaining({
						providerType: "MCP",
						providerKey: "github",
						providerDisplayName: "github",
						accessLevel: "WRITE",
					}),
				],
			}),
		);
	});
});

describe("2. Annotation precedence & canonical request fingerprinting", () => {
	it("treats destructiveHint: true as WRITE even when readOnlyHint: true is also set", () => {
		expect(
			classifyAccessLevel("list_items", {
				readOnlyHint: true,
				destructiveHint: true,
			}),
		).toBe("WRITE");

		for (const credential of [
			"oauth",
			"organization-key",
			"personal-key",
			"session",
		] as const) {
			expect(
				classifyConnectedToolAccess(
					"github__list_items",
					{ readOnlyHint: true, destructiveHint: true },
					credential,
				),
			).toBe("WRITE");
		}
	});

	it("produces identical SHA-256 digests between generateRequestFingerprint and authorityRequestFingerprint for nested objects", async () => {
		const argsA = {
			outer: { z: 1, a: [3, { d: 4, c: 5 }] },
			alpha: "hello",
		};
		const argsB = {
			alpha: "hello",
			outer: { a: [3, { c: 5, d: 4 }], z: 1 },
		};

		const gwFpA = await generateRequestFingerprint("create_issue", argsA);
		const gwFpB = await generateRequestFingerprint("create_issue", argsB);
		const dbFp = authorityRequestFingerprint("create_issue", argsA);

		expect(gwFpA).toBe(gwFpB);
		expect(gwFpA).toBe(dbFp);
	});
});

describe("3. Rich MCP result preservation & payload truncation", () => {
	it("preserves multiple content blocks (text, image, resource, resource_link), structuredContent, and _meta", () => {
		const rawResult = {
			content: [
				{ type: "text", text: "First block" },
				{ type: "text", text: "Second block" },
				{
					type: "image",
					data: "base64data",
					mimeType: "image/png",
				},
				{
					type: "resource",
					resource: {
						uri: "ui://widget/card.html",
						mimeType: "text/html",
						text: "<div>Card</div>",
					},
				},
				{
					type: "resource_link",
					uri: "https://example.com/doc",
					name: "Example Doc",
				},
			],
			structuredContent: { count: 2, items: ["a", "b"] },
			_meta: { "ui/resourceUri": "ui://widget/card.html" },
		};

		const parsed = parseMcpToolResult(rawResult);
		expect(parsed.content).toHaveLength(5);
		expect(parsed.content[0]).toEqual({
			type: "text",
			text: "First block",
		});
		expect(parsed.content[1]).toEqual({
			type: "text",
			text: "Second block",
		});
		expect(parsed.content[2]).toMatchObject({
			type: "image",
			data: "base64data",
			mimeType: "image/png",
		});
		expect(parsed.content[3]).toMatchObject({
			type: "resource",
			resource: {
				uri: "ui://widget/card.html",
				mimeType: "text/html",
				text: "<div>Card</div>",
			},
		});
		expect(parsed.content[4]).toMatchObject({
			type: "resource_link",
			uri: "https://example.com/doc",
			name: "Example Doc",
		});
		expect(parsed.structuredContent).toEqual({
			count: 2,
			items: ["a", "b"],
		});
		expect(parsed._meta).toEqual({
			"ui/resourceUri": "ui://widget/card.html",
		});
	});

	it("truncates oversized text blocks above 100 KB to protect the LLM context window", () => {
		const huge = "x".repeat(120_000);
		const parsed = parseMcpToolResult({
			content: [{ type: "text", text: huge }],
		});
		expect(parsed.content[0]?.text.length).toBeLessThan(101_000);
		expect(parsed.content[0]?.text).toContain(
			"[Truncated 20000 characters to protect context window]",
		);
	});
});

describe("4. Composio v3 / Rube discovery parity (multi-query, synonyms, server filter, outputSchema, multi-execute)", () => {
	const session = {
		credential: "personal-key" as const,
		scopes: ["*"],
	};
	const tools: GatewayToolDefinition[] = [
		{
			name: "github__create_pull_request",
			description: "[GitHub] Open a pull request in a repository.",
			inputSchema: { type: "object", properties: {} },
			outputSchema: {
				type: "object",
				properties: { number: { type: "integer" } },
			},
			annotations: { readOnlyHint: false },
		},
		{
			name: "linear__list_issues",
			description: "[Linear] List issues in a team.",
			inputSchema: { type: "object", properties: {} },
			annotations: { readOnlyHint: true },
		},
		{
			name: "fabric_list_projects",
			description: "List the projects in this organization.",
			inputSchema: { type: "object", properties: {} },
			annotations: { readOnlyHint: true },
		},
	];

	it("supports multi-query search_tools, synonym expansion, and server filter", () => {
		// Synonym expansion: "pr" matches "pull" / "request"
		const prSearch = JSON.parse(
			searchTools(session, tools, { query: "pr" }).content[0].text,
		) as { total: number; tools: Array<{ name: string }> };
		expect(prSearch.tools.map((t) => t.name)).toContain(
			"github__create_pull_request",
		);

		// Multi-query array
		const multiSearch = JSON.parse(
			searchTools(session, tools, {
				queries: ["pull request", "projects"],
			}).content[0].text,
		) as { total: number; tools: Array<{ name: string }> };
		expect(multiSearch.tools.map((t) => t.name)).toEqual([
			"github__create_pull_request",
			"fabric_list_projects",
		]);

		// Server filter
		const linearOnly = JSON.parse(
			searchTools(session, tools, {
				query: "list",
				server: "linear",
			}).content[0].text,
		) as { total: number; tools: Array<{ name: string }> };
		expect(linearOnly.tools.map((t) => t.name)).toEqual([
			"linear__list_issues",
		]);
	});

	it("returns outputSchema in get_tool_schema when present on the tool", () => {
		const schemaResult = JSON.parse(
			getToolSchema(session, tools, {
				name: "github__create_pull_request",
			}).content[0].text,
		) as { outputSchema?: Record<string, unknown> };
		expect(schemaResult.outputSchema).toEqual({
			type: "object",
			properties: { number: { type: "integer" } },
		});
	});

	it("validates batch calls in parseMultiExecuteArguments and rejects recursive meta-tool calls", () => {
		const valid = parseMultiExecuteArguments({
			calls: [
				{ name: "fabric_list_projects", arguments: { limit: 5 } },
				{ name: "linear__list_issues" },
			],
		});
		expect(valid).toEqual({
			ok: true,
			calls: [
				{ name: "fabric_list_projects", arguments: { limit: 5 } },
				{ name: "linear__list_issues", arguments: {} },
			],
		});

		const recursive = parseMultiExecuteArguments({
			calls: [{ name: MULTI_EXECUTE_TOOL_NAME, arguments: {} }],
		});
		expect(recursive.ok).toBe(false);

		const recursiveManage = parseMultiExecuteArguments({
			calls: [{ name: MANAGE_CONNECTIONS_NAME, arguments: {} }],
		});
		expect(recursiveManage.ok).toBe(false);
	});
});
