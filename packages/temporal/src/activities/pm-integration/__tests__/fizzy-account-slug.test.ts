/**
 * Tests for `resolveFizzyAccountSlug`.
 *
 * The helper exists because Fizzy MCP tools require `account_slug` but it's
 * not always in `additionalContext`. Live staging logs showed 117
 * `fizzy_get_card` failures per 45 min because `fetchPMItemsByIds` lacked
 * the fallback that `listWorkItemsFromPM` had inline.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMcpToolMock } = vi.hoisted(() => ({
	executeMcpToolMock: vi.fn(),
}));

vi.mock("../../orchestrator/execution/execute-mcp-tool", () => ({
	executeMcpTool: executeMcpToolMock,
}));

import { resolveFizzyAccountSlug } from "../fizzy-account-slug";

const BASE = {
	mcpConfigId: "mcp-1",
	userId: "user-1",
	organizationId: "org-1",
};

beforeEach(() => {
	executeMcpToolMock.mockReset();
});

describe("resolveFizzyAccountSlug", () => {
	it("returns context unchanged for non-Fizzy tools", async () => {
		const result = await resolveFizzyAccountSlug({
			...BASE,
			toolName: "wit_get_work_item",
			availableTools: ["wit_get_work_item", "fizzy_get_accounts"],
			additionalContext: { something: "else" },
		});
		expect(result.additionalContext).toEqual({ something: "else" });
		expect(result.resolvedSlug).toBeUndefined();
		expect(executeMcpToolMock).not.toHaveBeenCalled();
	});

	it("returns context unchanged when account_slug is already set", async () => {
		const result = await resolveFizzyAccountSlug({
			...BASE,
			toolName: "fizzy_get_card",
			availableTools: ["fizzy_get_card", "fizzy_get_accounts"],
			additionalContext: { account_slug: "techfabric" },
		});
		expect(result.additionalContext).toEqual({
			account_slug: "techfabric",
		});
		expect(executeMcpToolMock).not.toHaveBeenCalled();
	});

	it("returns context unchanged when `slug` (legacy key) is set", async () => {
		const result = await resolveFizzyAccountSlug({
			...BASE,
			toolName: "fizzy_get_cards",
			availableTools: ["fizzy_get_cards", "fizzy_get_accounts"],
			additionalContext: { slug: "legacy-slug" },
		});
		expect(result.additionalContext).toEqual({ slug: "legacy-slug" });
		expect(executeMcpToolMock).not.toHaveBeenCalled();
	});

	it("resolves account_slug from fizzy_get_accounts when missing", async () => {
		executeMcpToolMock.mockResolvedValueOnce({
			success: true,
			output: {
				content: [
					{
						type: "text",
						text: JSON.stringify([{ slug: "tech-fabric" }]),
					},
				],
			},
		});

		const result = await resolveFizzyAccountSlug({
			...BASE,
			toolName: "fizzy_get_card",
			availableTools: ["fizzy_get_card", "fizzy_get_accounts"],
			additionalContext: undefined,
		});

		expect(result.resolvedSlug).toBe("tech-fabric");
		expect(result.additionalContext).toEqual({
			account_slug: "tech-fabric",
		});
		expect(executeMcpToolMock).toHaveBeenCalledWith(
			expect.objectContaining({
				toolName: "fizzy_get_accounts",
				args: {},
			}),
		);
	});

	it("falls back to fizzy_get_identity when accounts tool returns nothing", async () => {
		// fizzy_get_accounts → empty
		executeMcpToolMock.mockResolvedValueOnce({
			success: true,
			output: { content: [{ type: "text", text: JSON.stringify([]) }] },
		});
		// fizzy_get_identity → has accounts
		executeMcpToolMock.mockResolvedValueOnce({
			success: true,
			output: {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							identity: {
								accounts: [{ account_slug: "via-identity" }],
							},
						}),
					},
				],
			},
		});

		const result = await resolveFizzyAccountSlug({
			...BASE,
			toolName: "fizzy_get_card",
			availableTools: [
				"fizzy_get_card",
				"fizzy_get_accounts",
				"fizzy_get_identity",
			],
			additionalContext: {},
		});

		expect(result.resolvedSlug).toBe("via-identity");
		expect(result.additionalContext).toEqual({
			account_slug: "via-identity",
		});
		expect(executeMcpToolMock).toHaveBeenCalledTimes(2);
	});

	it("returns context unchanged when MCP probe throws (defensive)", async () => {
		executeMcpToolMock.mockRejectedValueOnce(new Error("MCP server down"));

		const result = await resolveFizzyAccountSlug({
			...BASE,
			toolName: "fizzy_get_card",
			availableTools: ["fizzy_get_card", "fizzy_get_accounts"],
			additionalContext: {},
		});

		expect(result.additionalContext).toEqual({});
		expect(result.resolvedSlug).toBeUndefined();
	});

	it("falls through alternative slug keys (id, key) when no slug field", async () => {
		executeMcpToolMock.mockResolvedValueOnce({
			success: true,
			output: {
				content: [
					{
						type: "text",
						// No slug or account_slug — falls through to id
						text: JSON.stringify([{ id: "fallback-id" }]),
					},
				],
			},
		});

		const result = await resolveFizzyAccountSlug({
			...BASE,
			toolName: "fizzy_get_card",
			availableTools: ["fizzy_get_card", "fizzy_get_accounts"],
			additionalContext: {},
		});

		expect(result.resolvedSlug).toBe("fallback-id");
	});
});
