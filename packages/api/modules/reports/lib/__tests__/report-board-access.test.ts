import { beforeEach, expect, it, vi } from "vitest";

const { getClient, tools, execute } = vi.hoisted(() => ({
	getClient: vi.fn(),
	tools: vi.fn(),
	execute: vi.fn(),
}));
vi.mock("@repo/mcp", () => ({ getCachedMcpClientForConfig: getClient }));

import { boardIsListedForConfig } from "../report-board-access";

const request = {
	configId: "example-config",
	userId: "example-user",
	organizationId: "example-org",
	boardId: "42",
	accountSlug: "example-account",
};

beforeEach(() => {
	vi.resetAllMocks();
	getClient.mockResolvedValue({ client: { tools } });
	tools.mockResolvedValue({ example_list_boards: { execute } });
});

it("checks a wrapped listing on the caller's read-only connection and account", async () => {
	execute.mockResolvedValue({
		content: [
			null,
			{ type: "image" },
			{ type: "text", text: "unreadable JSON" },
			{ type: "text", text: JSON.stringify({ result: [{ id: 42 }] }) },
		],
	});
	await expect(boardIsListedForConfig(request)).resolves.toBe(true);
	expect(getClient).toHaveBeenCalledExactlyOnceWith({
		configId: request.configId,
		userId: request.userId,
		organizationId: request.organizationId,
		access: "read",
	});
	expect(execute).toHaveBeenCalledExactlyOnceWith(
		{ account_slug: request.accountSlug },
		{
			toolCallId: "report-board-check",
			messages: [],
			context: {},
			abortSignal: expect.any(AbortSignal),
		},
	);
});

it.each([true, false])(
	"checks a bare listing without passing a blank account (present: %s)",
	async (present) => {
		execute.mockResolvedValue([
			{ id: present ? "42" : "other-board" },
			{ id: false },
			null,
		]);
		await expect(
			boardIsListedForConfig({ ...request, accountSlug: "" }),
		).resolves.toBe(present);
		expect(execute).toHaveBeenCalledWith({}, expect.anything());
	},
);

it("returns false when the listing tool has no execute method", async () => {
	tools.mockResolvedValue({ list_boards: {} });
	await expect(boardIsListedForConfig(request)).resolves.toBe(false);
	expect(execute).not.toHaveBeenCalled();
});

it("returns false when the connection cannot be read for the caller's organization", async () => {
	getClient.mockRejectedValue(new Error("Connection is inaccessible"));
	await expect(boardIsListedForConfig(request)).resolves.toBe(false);
	expect(tools).not.toHaveBeenCalled();
});

it("returns false when the listing call fails", async () => {
	execute.mockRejectedValue(new Error("Listing unavailable"));
	await expect(boardIsListedForConfig(request)).resolves.toBe(false);
	expect(execute).toHaveBeenCalledOnce();
});
