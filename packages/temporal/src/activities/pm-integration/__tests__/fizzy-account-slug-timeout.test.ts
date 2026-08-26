import { afterEach, describe, expect, it, vi } from "vitest";

const exec = vi.hoisted(() => ({ executeMcpTool: vi.fn() }));
vi.mock("../../orchestrator/execution/execute-mcp-tool", () => exec);
vi.mock("../story-sync", () => ({
	parseMcpArrayFromOutput: (o: { accounts?: unknown[] } | null) =>
		o?.accounts ?? [],
}));

import { resolveFizzyAccountSlug } from "../fizzy-account-slug";

describe("resolveFizzyAccountSlug callTimeoutMs", () => {
	afterEach(() => exec.executeMcpTool.mockReset());

	it("forwards callTimeoutMs as timeoutMs to the account probe", async () => {
		exec.executeMcpTool.mockResolvedValue({
			success: true,
			output: { accounts: [{ slug: "acme" }] },
		});
		const res = await resolveFizzyAccountSlug({
			toolName: "fizzy_get_card",
			availableTools: ["fizzy_get_accounts", "fizzy_get_card"],
			additionalContext: {},
			mcpConfigId: "cfg1",
			userId: "u1",
			callTimeoutMs: 20_000,
		});
		expect(res.resolvedSlug).toBe("acme");
		expect(exec.executeMcpTool).toHaveBeenCalledWith(
			expect.objectContaining({ timeoutMs: 20_000 }),
		);
	});

	it("fails soft (no slug) when the probe returns a timeout failure result", async () => {
		exec.executeMcpTool.mockResolvedValue({
			success: false,
			output: {
				error: 'MCP tool "fizzy_get_accounts" timed out after 20000ms',
			},
		});
		const res = await resolveFizzyAccountSlug({
			toolName: "fizzy_get_card",
			availableTools: ["fizzy_get_accounts"],
			additionalContext: { existing: "x" },
			mcpConfigId: "cfg1",
			userId: "u1",
			callTimeoutMs: 20_000,
		});
		expect(res.resolvedSlug).toBeUndefined();
		expect(res.additionalContext).toEqual({ existing: "x" });
	});
});
