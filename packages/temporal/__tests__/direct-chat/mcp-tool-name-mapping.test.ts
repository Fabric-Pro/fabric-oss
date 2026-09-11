/**
 * Fizzy #2473. The model-facing tool name is also the key of
 * `toolToServerMap`, which is what turns a tool call back into "which server,
 * which original tool". Repairing the name is only correct while both stay the
 * same string — a refactor that sanitizes the tool key and leaves the map key
 * on the old form would dispatch every repaired tool into nothing.
 *
 * `@repo/agent-core/backend` and `@repo/database` are mocked because ESM
 * evaluation of `mcp-tools.ts` pulls them in at import time.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MCP_TOOL_NAME_PATTERN } from "../../src/activities/direct-chat/tool-payload-safety";

const getMcpClientMock = vi.fn();

vi.mock("@repo/agent-core/backend", () => ({
	closeMcpClientSafe: vi.fn(),
	getDetailedMcpToolInfo: vi.fn(),
	getMcpClient: (...args: unknown[]) => getMcpClientMock(...args),
}));

vi.mock("@repo/database", () => ({
	db: {},
}));

const { getMcpClientsForExecution } = await import(
	"../../src/activities/direct-chat/mcp-tools"
);

const serverWithTools = (tools: string[]) => ({
	client: {
		tools: async () =>
			Object.fromEntries(
				tools.map((name) => [
					name,
					{ description: name, inputSchema: {}, execute: vi.fn() },
				]),
			),
	},
});

describe("getMcpClientsForExecution — tool naming", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("names a tool from an illegal server name legally, and maps it back", async () => {
		getMcpClientMock.mockResolvedValue(serverWithTools(["post_message"]));

		const { tools, toolToServerMap } = await getMcpClientsForExecution(
			[
				{
					configId: "cfg-slack",
					configName: "Slack (Official)",
					serverName: "Slack (Official)",
					tools: [],
				},
			] as never,
			"user-1",
			"org-1",
		);

		const [name] = Object.keys(tools);
		expect(name).toMatch(MCP_TOOL_NAME_PATTERN);
		// The key the model is given must be the key dispatch resolves.
		expect(toolToServerMap[name]).toMatchObject({
			configId: "cfg-slack",
			serverName: "Slack (Official)",
		});
	});

	it("keeps two servers that repair alike from overwriting each other", async () => {
		getMcpClientMock
			.mockResolvedValueOnce(serverWithTools(["post_message"]))
			.mockResolvedValueOnce(serverWithTools(["post_message"]));

		const { tools, toolToServerMap } = await getMcpClientsForExecution(
			[
				{
					configId: "cfg-a",
					configName: "Slack (Official)",
					serverName: "Slack (Official)",
					tools: [],
				},
				{
					configId: "cfg-b",
					configName: "Slack Official",
					serverName: "Slack Official",
					tools: [],
				},
			] as never,
			"user-1",
			"org-1",
		);

		expect(Object.keys(tools)).toHaveLength(2);
		const configIds = Object.values(toolToServerMap).map(
			(entry) => entry.configId,
		);
		expect(new Set(configIds)).toEqual(new Set(["cfg-a", "cfg-b"]));
	});
});
