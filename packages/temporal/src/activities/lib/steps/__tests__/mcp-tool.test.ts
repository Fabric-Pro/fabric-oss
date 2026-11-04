import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	close: vi.fn(),
	execute: vi.fn(),
	tools: vi.fn(),
}));
vi.mock("@repo/mcp", () => ({
	createMcpClientForConfig: mocks.create,
	closeMcpClient: mocks.close,
	OAuthAuthorizationRequiredError: class extends Error {},
}));
vi.mock("@repo/utils", () => ({ getBaseUrl: () => "https://example.com" }));

import { executeMcpToolStep } from "../mcp-tool";

const run = (
	nodeConfig: Record<string, unknown> = {},
	text = 'Text with "quotes"\nand newlines',
) =>
	executeMcpToolStep({
		userId: "example-user",
		organizationId: "example-org",
		nodeConfig: {
			mcpServers: ["example-server"],
			toolName: "example_tool",
			toolArgs: '{"query":"{{previous.text}}"}',
			...nodeConfig,
		},
		inputs: { previous: { text } },
	});
beforeEach(() => {
	vi.clearAllMocks();
	mocks.create.mockResolvedValue({
		client: { tools: mocks.tools },
		serverName: "Example MCP",
	});
	mocks.tools.mockResolvedValue({ example_tool: { execute: mocks.execute } });
	mocks.execute.mockResolvedValue({
		content: [{ type: "text", text: "Example result" }],
	});
	mocks.close.mockResolvedValue(undefined);
});
describe("MCP workflow step", () => {
	it("executes with interpolated JSON and tenant-bound credentials", async () => {
		const result = await run();
		expect(result.success).toBe(true);
		expect(mocks.execute.mock.calls[0][0]).toEqual({
			query: 'Text with "quotes"\nand newlines',
		});
		expect(mocks.create).toHaveBeenCalledWith(
			expect.objectContaining({
				configId: "example-server",
				userId: "example-user",
				organizationId: "example-org",
			}),
		);
		expect(result.output).toMatchObject({
			text: "Example result",
			serverName: "Example MCP",
		});
		expect(mocks.close).toHaveBeenCalledOnce();
	});
	it("wraps a plain text template in a query object", async () => {
		await run({ toolArgs: "{{previous.text}}" });
		expect(mocks.execute.mock.calls[0][0]).toEqual({
			query: 'Text with "quotes"\nand newlines',
		});
	});
	it.each(["[URGENT] Build failed", "[1]", "{unfinished text"])(
		"wraps bracket-prefixed bare text %s without treating it as explicit JSON",
		async (text) => {
			const result = await run({ toolArgs: "{{previous.text}}" }, text);
			expect(result.success).toBe(true);
			expect(mocks.execute.mock.calls[0][0]).toEqual({ query: text });
		},
	);
	it("accepts a complete object from an upstream JSON template", async () => {
		const result = await run(
			{ toolArgs: "{{previous.text}}" },
			'{"text":"Example"}',
		);
		expect(result.success).toBe(true);
		expect(mocks.execute.mock.calls[0][0]).toEqual({ text: "Example" });
	});

	it("fails for an MCP error result instead of reporting a successful run", async () => {
		mocks.execute.mockResolvedValue({
			isError: true,
			content: [
				{ type: "text", text: "Example tool rejected the request" },
			],
		});
		const result = await run();
		expect(result.success).toBe(false);
		expect(result.error).toContain("Example tool rejected");
	});
	it("does not try another server when a dispatched tool reports an error", async () => {
		mocks.execute.mockResolvedValue({
			isError: true,
			content: [{ type: "text", text: "Example failure" }],
		});
		const result = await run({
			mcpServers: ["example-server", "second-server"],
		});
		expect(result.success).toBe(false);
		expect(mocks.create).toHaveBeenCalledTimes(1);
		expect(mocks.execute).toHaveBeenCalledTimes(1);
	});
	it("does not replay a tool on another server after an unconfirmed execution error", async () => {
		mocks.execute.mockRejectedValue(
			new Error("Example connection lost after dispatch"),
		);
		const result = await run({
			mcpServers: ["example-server", "second-server"],
		});
		expect(result.success).toBe(false);
		expect(result.error).toContain("may have");
		expect(mocks.create).toHaveBeenCalledTimes(1);
		expect(mocks.close).toHaveBeenCalledOnce();
	});
	it("can discover a tool on a later server before any execution was dispatched", async () => {
		mocks.tools.mockResolvedValueOnce({});
		const result = await run({
			mcpServers: ["first-server", "second-server"],
		});
		expect(result.success).toBe(true);
		expect(mocks.create).toHaveBeenCalledTimes(2);
		expect(mocks.execute).toHaveBeenCalledTimes(1);
	});
	it("rejects array tool arguments before connecting", async () => {
		const result = await run({ toolArgs: '["invalid-arguments"]' });
		expect(result.success).toBe(false);
		expect(result.error).toContain("object");
		expect(mocks.create).not.toHaveBeenCalled();
	});
	it("reports malformed JSON before connecting", async () => {
		const result = await run({ toolArgs: '{"query":' });
		expect(result.success).toBe(false);
		expect(result.error).toContain("Invalid JSON");
		expect(mocks.create).not.toHaveBeenCalled();
	});
	it("fails clearly when the selected server does not expose the tool", async () => {
		mocks.tools.mockResolvedValue({});
		const result = await run();
		expect(result.success).toBe(false);
		expect(result.error).toContain("not found");
		expect(mocks.execute).not.toHaveBeenCalled();
	});
});
