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
import type { PaginationInfo, PMToolCapabilities } from "../tool-analyzer";

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

describe("prompt-only PM hierarchy reads", () => {
	const card = {
		id: "example-card",
		title: "Example card",
		description_preview: "Useful short description",
	};
	const mockBoard = () =>
		wire.execute.mockImplementation(async ({ toolName }) =>
			ok(
				toolName === "fizzy_get_columns"
					? [{ id: "example-column", name: "Todo" }]
					: [card],
			),
		);

	it("back-fills a preview only with explicit prompt-only opt-in", async () => {
		mockBoard();
		const legacy = await readFizzyBoardCards({
			...input,
			fields: "summary",
		});
		expect(legacy).toMatchObject({
			kind: "ok",
			result: { items: [{ description: null }] },
		});
		const prompt = await readFizzyBoardCards({
			...input,
			fields: "summary",
			descriptionFromPreview: true,
		});
		expect(prompt).toMatchObject({
			kind: "ok",
			result: { items: [{ description: card.description_preview }] },
		});
	});

	it("requests summary and retains the preview only for prompt hierarchy reads", async () => {
		mockBoard();
		const legacy = await fetchPMWorkItemsByType(input);
		const legacyCall = wire.execute.mock.calls.find(
			([call]) => call.toolName === "fizzy_get_cards",
		);
		expect(legacyCall).toBeDefined();
		expect(legacyCall?.[0].args).not.toHaveProperty("fields");
		expect(legacy.stories[0].description).toBeNull();
		wire.execute.mockClear();
		const prompt = await fetchPMWorkItemsByType({
			...input,
			forPrompt: true,
		});
		expect(wire.execute).toHaveBeenCalledWith(
			expect.objectContaining({
				toolName: "fizzy_get_cards",
				args: expect.objectContaining({ fields: "summary" }),
			}),
		);
		expect(prompt.stories[0].description).toBe(card.description_preview);
	});

	it.each(["fizzy", "ado", "ado-partial-failure", "generic"])(
		"omits raw only for prompt reads: %s",
		async (provider) => {
			const ado = provider.startsWith("ado");
			const categories = [
				"Microsoft.EpicCategory",
				"Microsoft.FeatureCategory",
				"Microsoft.RequirementCategory",
			];
			wire.execute.mockImplementation(async ({ toolName, args }) => {
				if (toolName === "fizzy_get_columns") {
					return ok([{ id: "example-column", name: "Todo" }]);
				}
				if (toolName === "wit_list_backlogs") {
					return ok(categories.map((id) => ({ id })));
				}
				if (
					provider === "ado-partial-failure" &&
					args.backlogId === categories[2]
				) {
					return { success: false };
				}
				return ok([{ ...card, description: "Full description" }]);
			});
			const args = {
				...input,
				capabilities: {
					...capabilities,
					detectedType:
						provider === "fizzy"
							? "fizzy"
							: ado
								? "azure-devops"
								: "linear",
					taskList: {
						...taskList,
						toolName: ado
							? "wit_list_backlog_work_items"
							: "fizzy_get_cards",
					},
				},
			};
			const legacy = await fetchPMWorkItemsByType(args);
			const prompt = await fetchPMWorkItemsByType({
				...args,
				forPrompt: true,
			});
			const legacyItems = [
				...legacy.epics,
				...legacy.features,
				...legacy.stories,
			];
			const promptItems = [
				...prompt.epics,
				...prompt.features,
				...prompt.stories,
			];
			expect(legacyItems).toHaveLength(
				ado ? (provider === "ado" ? 3 : 2) : 1,
			);
			expect(promptItems).toHaveLength(legacyItems.length);
			for (const item of legacyItems) {
				expect(item.raw).toEqual({
					...card,
					description: "Full description",
				});
			}
			for (const item of promptItems) {
				expect(item).not.toHaveProperty("raw");
			}
			expect(prompt).toEqual({
				...legacy,
				epics: legacy.epics.map(({ raw: _raw, ...item }) => item),
				features: legacy.features.map(({ raw: _raw, ...item }) => item),
				stories: legacy.stories.map(({ raw: _raw, ...item }) => item),
			});
		},
	);
});

describe("non-ADO paged hierarchy reads", () => {
	const pagedInput = (paginationInfo: PaginationInfo) => ({
		...input,
		forPrompt: true,
		capabilities: {
			...capabilities,
			detectedType: "github",
			taskList: {
				...taskList,
				toolName: "list_issues",
				filterParams: ["team"],
				paginationInfo,
			},
		},
	});
	const numbered = {
		style: "offset-page" as const,
		pageParam: "page",
		pageSizeParam: "per_page",
	};
	const items = (start: number, length: number) =>
		Array.from({ length }, (_, i) => ({
			id: 9999999 + i,
			number: start + i,
			title: "Example issue",
			description: "x".repeat(800),
		}));

	it.each([
		numbered,
		{
			style: "offset-skip" as const,
			skipParam: "startAt",
			pageSizeParam: "maxResults",
		},
	])(
		"multi-page read collects pages with $style args",
		async (paginationInfo) => {
			wire.execute
				.mockResolvedValueOnce(ok({ issues: items(42, 50), total: 52 }))
				.mockResolvedValueOnce(ok({ issues: items(92, 2), total: 52 }));
			const result = await fetchPMWorkItemsByType(
				pagedInput(paginationInfo),
			);
			expect(result.stories).toHaveLength(52);
			expect(result.stories[0].id).toBe("42");
			expect(wire.execute).toHaveBeenCalledTimes(2);
			for (const [index, [call]] of wire.execute.mock.calls.entries()) {
				expect(call.args).toEqual(
					paginationInfo.style === "offset-page"
						? {
								board_id: "example-board",
								team: "example-team",
								page: index + 1,
								per_page: 50,
							}
						: {
								board_id: "example-board",
								team: "example-team",
								startAt: index * 50,
								maxResults: 50,
							},
				);
			}
			expect(result.listingTruncated).not.toBe(true);
			for (const item of result.stories) {
				expect(item).not.toHaveProperty("raw");
				expect(item.description?.length).toBeLessThanOrEqual(500);
			}
		},
	);
	it.each(["maxResults", undefined])(
		"skip offsets follow raw 20-item pages with size param %s",
		async (pageSizeParam) => {
			wire.execute.mockImplementation(async ({ args }) =>
				ok({
					issues: items(
						args.startAt,
						Math.max(0, Math.min(20, 100 - args.startAt)),
					),
					total: 100,
				}),
			);
			const result = await fetchPMWorkItemsByType(
				pagedInput({
					style: "offset-skip",
					skipParam: "startAt",
					pageSizeParam,
				}),
			);
			expect(result.stories).toHaveLength(100);
			expect(result.stories.map((item) => item.id)).toEqual(
				Array.from({ length: 100 }, (_, i) => String(i)),
			);
			expect(
				wire.execute.mock.calls.map(([call]) => call.args.startAt),
			).toEqual([0, 20, 40, 60, 80]);
			expect(result.readStatus).toBe("ok");
			expect(result.listingTruncated).not.toBe(true);
		},
	);

	it.each([
		{ total: 50 },
		{ totalCount: 50 },
		{ total_count: 50 },
		{ meta: { total: 50 } },
		{ pagination: { total: 50 } },
	])("trusts envelope total %j even on a full page", async (metadata) => {
		wire.execute.mockResolvedValue(
			ok({ issues: items(1, 50), ...metadata }),
		);
		const result = await fetchPMWorkItemsByType(pagedInput(numbered));
		expect(result.stories).toHaveLength(50);
		expect(wire.execute).toHaveBeenCalledTimes(1);
		expect(result.listingTruncated).not.toBe(true);
	});
	it("detects an effective size cap and excludes count from totals", async () => {
		wire.execute
			.mockResolvedValueOnce(ok({ issues: items(1, 30), count: 30 }))
			.mockResolvedValueOnce(ok({ issues: items(31, 30), count: 30 }))
			.mockResolvedValueOnce(ok({ issues: items(61, 4), count: 4 }));
		const result = await fetchPMWorkItemsByType(pagedInput(numbered));
		expect(result.stories).toHaveLength(64);
		expect(wire.execute).toHaveBeenCalledTimes(3);
		expect(result.listingTruncated).not.toBe(true);
	});
	it("treats an empty page after a full page without total as the end of the list", async () => {
		wire.execute
			.mockResolvedValueOnce(ok(items(1, 50)))
			.mockResolvedValueOnce(ok([]));
		const result = await fetchPMWorkItemsByType(pagedInput(numbered));
		expect(result.stories).toHaveLength(50);
		expect(wire.execute).toHaveBeenCalledTimes(2);
		expect(result.listingTruncated).not.toBe(true);
	});
	it("marks a repeated full page without total as truncated", async () => {
		wire.execute.mockResolvedValue(ok(items(1, 50)));
		const result = await fetchPMWorkItemsByType(pagedInput(numbered));
		expect(result.stories).toHaveLength(50);
		expect(wire.execute).toHaveBeenCalledTimes(2);
		expect(result.listingTruncated).toBe(true);
	});
	it("fails the read when a page after a confirmed size cap is refused", async () => {
		wire.execute
			.mockResolvedValueOnce(ok(items(1, 30)))
			.mockResolvedValueOnce(ok(items(31, 30)))
			.mockResolvedValueOnce({
				success: false,
				error: "403 secret-token",
			});
		const result = await fetchPMWorkItemsByType(pagedInput(numbered));
		expect(result).toMatchObject({
			readStatus: "failed",
			readErrorKind: "credentials",
			stories: [],
		});
		expect(wire.execute).toHaveBeenCalledTimes(3);
	});
	it.each([undefined, 501, 500])(
		"caps at 500 with total %s",
		async (total) => {
			wire.execute.mockImplementation(async ({ args }) =>
				ok({ issues: items((args.page - 1) * 50 + 1, 50), total }),
			);
			const result = await fetchPMWorkItemsByType(pagedInput(numbered));
			expect(result.stories).toHaveLength(500);
			expect(wire.execute).toHaveBeenCalledTimes(10);
			expect(result.listingTruncated === true).toBe(total !== 500);
		},
	);
	it("caps at 20 pages when the tool limits pages to 10 items", async () => {
		wire.execute.mockImplementation(async ({ args }) =>
			ok(items((args.page - 1) * 10 + 1, 10)),
		);
		const result = await fetchPMWorkItemsByType(pagedInput(numbered));
		expect(result.stories).toHaveLength(200);
		expect(wire.execute).toHaveBeenCalledTimes(20);
		expect(result.listingTruncated).toBe(true);
	});
	it("deduplicates overlapping pages and stops an ignored page argument with truncation when total says more remain", async () => {
		wire.execute.mockResolvedValue(
			ok({ issues: items(1, 50), total: 500 }),
		);
		const result = await fetchPMWorkItemsByType(pagedInput(numbered));
		expect(result.stories).toHaveLength(50);
		expect(new Set(result.stories.map((item) => item.id)).size).toBe(50);
		expect(wire.execute).toHaveBeenCalledTimes(2);
		expect(result.listingTruncated).toBe(true);
	});
	it("retains only new ids from overlapping pages", async () => {
		wire.execute
			.mockResolvedValueOnce(ok({ issues: items(1, 50), total: 70 }))
			.mockResolvedValueOnce(ok({ issues: items(21, 50), total: 70 }));
		const result = await fetchPMWorkItemsByType(pagedInput(numbered));
		expect(result.stories).toHaveLength(70);
		expect(new Set(result.stories.map((item) => item.id)).size).toBe(70);
		expect(wire.execute).toHaveBeenCalledTimes(2);
	});
	it.each(["cursor", "none"] as const)(
		"%s makes one call and reports known partial reads",
		async (style) => {
			for (const metadata of [
				{ total: 100 },
				{ pageInfo: { hasNextPage: true } },
				{},
			]) {
				wire.execute
					.mockReset()
					.mockResolvedValue(
						ok({ issues: items(1, 2), ...metadata }),
					);
				const result = await fetchPMWorkItemsByType(
					pagedInput({ style, cursorParam: "after" }),
				);
				expect(result.stories).toHaveLength(2);
				expect(result.listingTruncated === true).toBe(
					Object.keys(metadata).length > 0,
				);
				expect(wire.execute).toHaveBeenCalledTimes(1);
				expect(wire.execute.mock.calls[0][0].args).toEqual({
					board_id: "example-board",
					team: "example-team",
				});
			}
		},
	);
	it.each(["refused", "throw", "malformed", "unknown-envelope"])(
		"later page %s fails the whole read",
		async (mode) => {
			wire.execute
				.mockResolvedValueOnce(ok({ issues: items(1, 50), total: 70 }))
				.mockImplementationOnce(async () => {
					if (mode === "throw") {
						throw new Error("403 secret-token");
					}
					if (mode === "refused") {
						return { success: false, error: "403 secret-token" };
					}
					return mode === "unknown-envelope"
						? ok({ entries: [] })
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
							};
				});
			const result = await fetchPMWorkItemsByType(pagedInput(numbered));
			expect(result).toMatchObject({
				readStatus: "failed",
				readErrorKind:
					mode === "refused" || mode === "throw"
						? "credentials"
						: "other",
				stories: [],
			});
			expect(JSON.stringify(result)).not.toContain("secret-token");
			expect(wire.execute).toHaveBeenCalledTimes(2);
		},
	);
	it("advances skip offsets by raw rows before deduplication", async () => {
		wire.execute
			.mockResolvedValueOnce(
				ok({ issues: [...items(0, 20), ...items(0, 5)], total: 40 }),
			)
			.mockResolvedValueOnce(ok({ issues: items(20, 20), total: 40 }));
		const result = await fetchPMWorkItemsByType(
			pagedInput({ style: "offset-skip", skipParam: "startAt" }),
		);
		expect(
			wire.execute.mock.calls.map(([call]) => call.args.startAt),
		).toEqual([0, 25]);
		expect(result.stories).toHaveLength(40);
		expect(result.listingTruncated).not.toBe(true);
	});
	it("stops a repeated short page without total or more markers as complete", async () => {
		wire.execute.mockResolvedValue(ok(items(1, 12)));
		const result = await fetchPMWorkItemsByType(pagedInput(numbered));
		expect(result.stories).toHaveLength(12);
		expect(result.listingTruncated).not.toBe(true);
		expect(wire.execute).toHaveBeenCalledTimes(2);
	});
	it.each(["empty", "repeat"])(
		"retains known total evidence on a later %s page without metadata",
		async (mode) => {
			wire.execute
				.mockResolvedValueOnce(ok({ issues: items(1, 12), total: 120 }))
				.mockResolvedValueOnce(
					ok(mode === "empty" ? [] : items(1, 12)),
				);
			const result = await fetchPMWorkItemsByType(pagedInput(numbered));
			expect(result).toMatchObject({
				readStatus: "ok",
				listingTruncated: true,
			});
			expect(result.stories).toHaveLength(12);
		},
	);
	it.each(["empty", "repeat"])(
		"retains has-more evidence on a later %s page",
		async (mode) => {
			wire.execute
				.mockResolvedValueOnce(
					ok({ issues: items(1, 12), hasMore: true }),
				)
				.mockResolvedValueOnce(
					ok({
						issues: mode === "empty" ? [] : items(1, 12),
						hasMore: true,
					}),
				);
			const result = await fetchPMWorkItemsByType(pagedInput(numbered));
			expect(result).toMatchObject({
				readStatus: "ok",
				listingTruncated: true,
			});
		},
	);
	it.each(["refused", "throw", "malformed", "unknown-envelope"])(
		"failed short-page heuristic probe (%s) preserves the read with truncation",
		async (mode) => {
			wire.execute
				.mockResolvedValueOnce(ok(items(1, 12)))
				.mockImplementationOnce(async () => {
					if (mode === "throw") {
						throw new Error("403 secret-token");
					}
					if (mode === "refused") {
						return { success: false, error: "403 secret-token" };
					}
					return mode === "unknown-envelope"
						? ok({ entries: [] })
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
							};
				});
			const result = await fetchPMWorkItemsByType(pagedInput(numbered));
			expect(result).toMatchObject({
				readStatus: "ok",
				listingTruncated: true,
			});
			expect(result.stories).toHaveLength(12);
			expect(result).not.toHaveProperty("readErrorKind");
			expect(JSON.stringify(result)).not.toContain("secret-token");
		},
	);
	it.each([{ total: 120 }, { hasMore: true }])(
		"a short page with evidence %j requires the next page",
		async (metadata) => {
			wire.execute
				.mockResolvedValueOnce(
					ok({ issues: items(1, 12), ...metadata }),
				)
				.mockResolvedValueOnce({
					success: false,
					error: "403 secret-token",
				});
			const result = await fetchPMWorkItemsByType(pagedInput(numbered));
			expect(result).toMatchObject({
				readStatus: "failed",
				readErrorKind: "credentials",
				stories: [],
			});
		},
	);
	const moreMarkers = [
		{ hasNextPage: true },
		{ hasMore: true },
		{ has_more: true },
		{ nextCursor: "example-next" },
		{ next_cursor: "example-next" },
		{ nextPageToken: "example-next" },
		{ next_page_token: "example-next" },
		{ isLast: false },
		{ last_page: false },
	];
	it.each(moreMarkers)(
		"recognizes more marker %j for single-call and paged tools",
		async (marker) => {
			for (const metadata of [marker, { pageInfo: marker }]) {
				for (const style of ["cursor", "none"] as const) {
					wire.execute
						.mockReset()
						.mockResolvedValue(
							ok({ issues: items(1, 2), ...metadata }),
						);
					const result = await fetchPMWorkItemsByType(
						pagedInput({ style }),
					);
					expect(result).toMatchObject({
						readStatus: "ok",
						listingTruncated: true,
					});
					expect(wire.execute).toHaveBeenCalledTimes(1);
				}
				wire.execute
					.mockReset()
					.mockResolvedValueOnce(
						ok({ issues: items(1, 2), total: 2, ...metadata }),
					)
					.mockResolvedValueOnce(
						ok({ issues: items(3, 2), total: 4 }),
					);
				const result = await fetchPMWorkItemsByType(
					pagedInput(numbered),
				);
				expect(result.stories).toHaveLength(4);
				expect(wire.execute).toHaveBeenCalledTimes(2);
			}
		},
	);
	it("ignores empty tokens and false has-more markers", async () => {
		wire.execute.mockResolvedValue(
			ok({
				issues: items(1, 2),
				nextPageToken: "",
				hasMore: false,
				isLast: true,
				pageInfo: { nextCursor: "", last_page: true },
			}),
		);
		const result = await fetchPMWorkItemsByType(
			pagedInput({ style: "cursor" }),
		);
		expect(result.listingTruncated).not.toBe(true);
	});
});
