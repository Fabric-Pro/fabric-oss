import { beforeEach, describe, expect, it, vi } from "vitest";

const wire = vi.hoisted(() => ({ execute: vi.fn(), warn: vi.fn() }));
vi.mock("../../orchestrator/execution/execute-mcp-tool", () => ({
	executeMcpTool: wire.execute,
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: wire.warn, error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../pm-source", () => ({ assertPmMcpTargetOrigin: vi.fn() }));

import { fetchPMWorkItemsByType } from "../fetch-pm-hierarchy";
import { listAllFizzyCards, readFizzyBoardCards } from "../story-sync";
import type { PMToolCapabilities } from "../tool-analyzer";

const taskList = {
	toolName: "fizzy_get_cards",
	containerParam: "board_id",
	filterParams: [],
	allParams: [],
	additionalRequiredParams: [],
	paginationInfo: { style: "none" as const },
};
const capabilities = {
	detectedType: "fizzy",
	availableTools: ["fizzy_get_columns", "fizzy_get_cards"],
	taskList,
} as unknown as PMToolCapabilities;
const input = {
	projectId: "example-project",
	mcpConfigId: "example-config",
	containerId: "example-board",
	userId: "example-user",
	organizationId: "example-org",
	additionalContext: {
		account_slug: "example-account",
		team: "example-team",
	},
	capabilities,
};
const ok = (value: unknown) => ({
	success: true,
	output: { content: [{ type: "text", text: JSON.stringify(value) }] },
});
beforeEach(() => {
	wire.execute.mockReset();
	wire.warn.mockClear();
});

describe("Fizzy board read outcomes", () => {
	it.each([
		["missing config", { ...input, mcpConfigId: null }],
		["missing account", { ...input, additionalContext: undefined }],
		[
			"missing tools",
			{ ...input, capabilities: { ...capabilities, availableTools: [] } },
		],
	])(
		"reports unavailable: %s; legacy wrapper returns null",
		async (_, args) => {
			expect((await readFizzyBoardCards(args)).kind).toBe("unavailable");
			expect(await listAllFizzyCards(args)).toBeNull();
		},
	);
	it.each(["columns", "cards", "throw"])(
		"reports failed: %s; legacy wrapper returns null",
		async (stage) => {
			wire.execute.mockImplementation(async ({ toolName }) => {
				if (stage === "throw") {
					throw new Error("403 secret-token");
				}
				return stage === "cards" && toolName === "fizzy_get_columns"
					? ok([{ id: "example-column", name: "Todo" }])
					: { success: false, error: "403 secret-token" };
			});
			expect(await readFizzyBoardCards(input)).toMatchObject({
				kind: "failed",
				errorKind: "credentials",
			});
			expect(await listAllFizzyCards(input)).toBeNull();
		},
	);
	it("reports no-columns; legacy wrapper returns null", async () => {
		wire.execute.mockResolvedValue(ok([]));
		expect(await readFizzyBoardCards(input)).toEqual({
			kind: "no-columns",
		});
		expect(await listAllFizzyCards(input)).toBeNull();
	});
	it("reports ok for an empty column", async () => {
		wire.execute.mockImplementation(async ({ toolName }) =>
			ok(
				toolName === "fizzy_get_columns"
					? [{ id: "example-column", name: "Todo" }]
					: [],
			),
		);
		expect(await readFizzyBoardCards(input)).toMatchObject({
			kind: "ok",
			result: { items: [] },
		});
		expect(await listAllFizzyCards(input)).toMatchObject({ items: [] });
	});
});

describe("PM hierarchy read status", () => {
	it.each([
		["failed", { success: false, error: "403 secret-token" }],
		["no-columns", ok([])],
		["ok", ok([{ id: "example-column", name: "Todo" }])],
	])(
		"Fizzy reports %s without generic fallback",
		async (readStatus, response) => {
			wire.execute.mockImplementation(async ({ toolName }) =>
				toolName === "fizzy_get_columns" ? response : ok([]),
			);
			const result = await fetchPMWorkItemsByType(input);
			expect(result.readStatus).toBe(readStatus);
			expect(JSON.stringify(result)).not.toContain("secret-token");
			for (const [call] of wire.execute.mock.calls) {
				expect(call.args.account_slug).toBe("example-account");
			}
		},
	);
	it.each(["refused", "throw"])("generic %s reports failed", async (mode) => {
		wire.execute.mockImplementation(async () => {
			if (mode === "throw") {
				throw new Error("403 secret-token");
			}
			return { success: false, error: "403 secret-token" };
		});
		const result = await fetchPMWorkItemsByType({
			...input,
			capabilities: { ...capabilities, detectedType: "linear" },
		});
		expect(result.readStatus).toBe("failed");
		expect(result.readErrorKind).toBe("credentials");
		expect(JSON.stringify(result)).not.toContain("secret-token");
	});
	it.each(["refused", "throw"])(
		"ADO per-type %s retains other types and reports failed",
		async (mode) => {
			wire.execute.mockImplementation(async ({ toolName, args }) => {
				if (toolName === "wit_list_backlogs") {
					return ok([
						{
							id: "epics",
							categoryReferenceName: "Microsoft.EpicCategory",
						},
						{
							id: "stories",
							categoryReferenceName:
								"Microsoft.RequirementCategory",
						},
					]);
				}
				if (args.backlogId === "Microsoft.EpicCategory") {
					return ok([{ id: "example-epic", title: "Example epic" }]);
				}
				if (mode === "throw") {
					throw new Error("403 secret-token");
				}
				return { success: false, error: "403 secret-token" };
			});
			const result = await fetchPMWorkItemsByType({
				...input,
				capabilities: {
					...capabilities,
					detectedType: "azure-devops",
					taskList: {
						...taskList,
						toolName: "wit_list_backlog_work_items",
					},
				},
			});
			expect(result.readStatus).toBe("failed");
			expect(result.epics).toHaveLength(1);
			expect(result.readErrorKind).toBe("credentials");
		},
	);
	it.each(["refused", "throw", "malformed"])(
		"ADO category discovery %s reports failed",
		async (mode) => {
			wire.execute.mockImplementation(async () => {
				if (mode === "throw") {
					throw new Error("403 secret-token");
				}
				return mode === "malformed"
					? {
							success: true,
							output: {
								content: [
									{
										type: "text",
										text: "Unreadable response",
									},
								],
							},
						}
					: { success: false, error: "403 secret-token" };
			});
			const result = await fetchPMWorkItemsByType({
				...input,
				capabilities: {
					...capabilities,
					detectedType: "azure-devops",
					taskList: {
						...taskList,
						toolName: "wit_list_backlog_work_items",
					},
				},
			});
			expect(result.readStatus).toBe("failed");
		},
	);
	it("ADO missing categories are skipped successfully", async () => {
		wire.execute.mockResolvedValue(ok([]));
		const result = await fetchPMWorkItemsByType({
			...input,
			capabilities: {
				...capabilities,
				detectedType: "azure-devops",
				taskList: {
					...taskList,
					toolName: "wit_list_backlog_work_items",
				},
			},
		});
		expect(result.readStatus).toBe("ok");
		expect(wire.execute).toHaveBeenCalledTimes(1);
	});

	it.each(["generic", "ado"])(
		"%s unreadable list payload reports failed",
		async (provider) => {
			wire.execute.mockImplementation(async ({ toolName }) =>
				toolName === "wit_list_backlogs"
					? ok([{ id: "Microsoft.EpicCategory" }])
					: {
							success: true,
							output: {
								content: [
									{
										type: "text",
										text: "Unreadable response",
									},
								],
							},
						},
			);
			const result = await fetchPMWorkItemsByType({
				...input,
				capabilities: {
					...capabilities,
					detectedType: provider,
					taskList: {
						...taskList,
						toolName:
							provider === "ado"
								? "wit_list_backlog_work_items"
								: "list_items",
					},
				},
			});
			expect(result.readStatus).toBe("failed");
		},
	);
});

describe("successful unfamiliar PM payloads", () => {
	it("reads issues as stories", async () => {
		wire.execute.mockResolvedValue(
			ok({ issues: [{ number: 42, title: "Example issue" }] }),
		);
		expect(
			await fetchPMWorkItemsByType({
				...input,
				capabilities: { ...capabilities, detectedType: "jira" },
			}),
		).toMatchObject({
			readStatus: "ok",
			stories: [{ id: "42", title: "Example issue" }],
		});
	});

	it.each([
		["entries", ok({ entries: [{ id: "example-issue" }] })],
		["empty content", { success: true, output: { content: [] } }],
		[
			"empty text",
			{
				success: true,
				output: { content: [{ type: "text", text: "" }] },
			},
		],
	])(
		"generic %s stays ok with the legacy empty result",
		async (_, response) => {
			wire.execute.mockResolvedValue(response);
			expect(
				await fetchPMWorkItemsByType({
					...input,
					capabilities: { ...capabilities, detectedType: "jira" },
				}),
			).toMatchObject({ readStatus: "ok", stories: [] });
		},
	);
	it("unknown envelope warnings include keys without values", async () => {
		wire.execute.mockResolvedValue(
			ok({ entries: [{ id: "example-secret-value" }] }),
		);
		await fetchPMWorkItemsByType({
			...input,
			capabilities: { ...capabilities, detectedType: "jira" },
		});
		expect(wire.warn).toHaveBeenCalledWith(expect.any(String), {
			keys: ["entries"],
		});
		expect(JSON.stringify(wire.warn.mock.calls)).not.toContain(
			"example-secret-value",
		);
	});
	it("ADO unfamiliar category envelope fails the read", async () => {
		wire.execute.mockResolvedValue(ok({ categories: [] }));
		expect(
			await fetchPMWorkItemsByType({
				...input,
				capabilities: {
					...capabilities,
					detectedType: "azure-devops",
					taskList: {
						...taskList,
						toolName: "wit_list_backlog_work_items",
					},
				},
			}),
		).toMatchObject({ readStatus: "failed" });
	});
	it("ADO unfamiliar per-type envelope stays ok", async () => {
		wire.execute.mockImplementation(async ({ toolName }) =>
			toolName === "wit_list_backlogs"
				? ok([{ id: "Microsoft.EpicCategory" }])
				: ok({ issues: [] }),
		);
		expect(
			await fetchPMWorkItemsByType({
				...input,
				capabilities: {
					...capabilities,
					detectedType: "azure-devops",
					taskList: {
						...taskList,
						toolName: "wit_list_backlog_work_items",
					},
				},
			}),
		).toMatchObject({ readStatus: "ok" });
	});
	it("Fizzy non-array columns fail the read, not report no columns", async () => {
		wire.execute.mockResolvedValue(ok({ columns: [] }));
		expect(await readFizzyBoardCards(input)).toMatchObject({
			kind: "failed",
		});
		expect(await listAllFizzyCards(input)).toBeNull();
	});
	it("legacy Fizzy wrapper returns null when columns throw a circular object", async () => {
		const error: Record<string, unknown> = {};
		error.output = error;
		wire.execute.mockRejectedValue(error);
		expect(await listAllFizzyCards(input)).toBeNull();
	});
	it("non-credential failures return a code without raw error text", async () => {
		wire.execute.mockResolvedValue({
			success: false,
			error: "board 14031 timed out after 40300ms",
		});
		const result = await fetchPMWorkItemsByType({
			...input,
			capabilities: { ...capabilities, detectedType: "jira" },
		});
		expect(result.readErrorKind).toBe("other");
		expect(result).not.toHaveProperty("readError");
	});
});
