import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../orchestrator/execution/execute-mcp-tool", () => ({
	executeMcpTool: vi.fn(),
}));

import { executeMcpTool } from "../../orchestrator/execution/execute-mcp-tool";
import {
	fetchPmComments,
	MAX_CHARS_PER_COMMENT,
	MAX_COMMENTS,
} from "../fetch-pm-comments";
import type { PMToolCapabilities } from "../tool-analyzer";

const caps = (detectedType: string, withComments = true): PMToolCapabilities =>
	({
		hasPMCapabilities: true,
		containerHierarchy: [],
		availableTools: [],
		detectedType,
		taskComments: withComments
			? {
					toolName: "get_comments",
					idParam: "card_id",
					additionalRequiredParams: [],
					allParams: [],
				}
			: undefined,
	}) as unknown as PMToolCapabilities;

const baseInput = {
	mcpConfigId: "mcp-1",
	userId: "user-1",
	organizationId: undefined,
	capabilities: caps("fizzy"),
	externalId: "42",
	containerId: "container-1",
};

describe("fetchPmComments", () => {
	beforeEach(() => vi.mocked(executeMcpTool).mockReset());

	it("returns [] when there is no taskComments capability (no adapter call)", async () => {
		const result = await fetchPmComments({
			...baseInput,
			capabilities: caps("fizzy", false),
		});
		expect(result).toEqual([]);
		expect(executeMcpTool).not.toHaveBeenCalled();
	});

	it("returns [] (no throw) when the adapter reports failure", async () => {
		vi.mocked(executeMcpTool).mockResolvedValueOnce({
			success: false,
			output: { error: "boom" },
		} as never);
		await expect(fetchPmComments(baseInput)).resolves.toEqual([]);
	});

	it("normalizes ADO-style comments (text / createdBy.displayName / createdDate)", async () => {
		vi.mocked(executeMcpTool).mockResolvedValueOnce({
			success: true,
			output: {
				comments: [
					{
						text: "First note",
						createdBy: { displayName: "Dana Lee" },
						createdDate: "2026-05-26T10:00:00Z",
					},
				],
			},
		} as never);
		const result = await fetchPmComments({
			...baseInput,
			capabilities: caps("azure-devops"),
		});
		expect(result).toEqual([
			{
				author: "Dana Lee",
				createdAt: "2026-05-26T10:00:00.000Z",
				body: "First note",
			},
		]);
	});

	it("normalizes a bare array of Fizzy-style comments (body / user.name / created_at)", async () => {
		vi.mocked(executeMcpTool).mockResolvedValueOnce({
			success: true,
			output: [
				{
					body: "Hi",
					user: { name: "Sam" },
					created_at: "2026-05-24T12:00:00.000Z",
				},
			],
		} as never);
		const result = await fetchPmComments(baseInput);
		expect(result[0]).toEqual({
			author: "Sam",
			createdAt: "2026-05-24T12:00:00.000Z",
			body: "Hi",
		});
	});

	it("normalizes Fizzy-style comments with a structured { plain_text, html } body", async () => {
		vi.mocked(executeMcpTool).mockResolvedValueOnce({
			success: true,
			output: [
				{
					body: {
						plain_text: "Create database and IOS app",
						html: "<div><p>Create database and IOS app</p></div>",
					},
					creator: { name: "Vlad" },
					created_at: "2026-06-18T09:20:00.000Z",
				},
			],
		} as never);
		const result = await fetchPmComments(baseInput);
		expect(result[0]).toEqual({
			author: "Vlad",
			createdAt: "2026-06-18T09:20:00.000Z",
			body: "Create database and IOS app",
		});
	});

	it("strips tags from an html-only body (no plain_text/text) unchanged by the bound", async () => {
		vi.mocked(executeMcpTool).mockResolvedValueOnce({
			success: true,
			output: [
				{
					body: {
						html: "<div><p>Create database and IOS app</p></div>",
					},
					creator: { name: "Vlad" },
					created_at: "2026-06-18T09:20:00.000Z",
				},
			],
		} as never);
		const result = await fetchPmComments(baseInput);
		expect(result[0]?.body).toBe("Create database and IOS app");
	});

	it("does not hang on an html-only body with a huge unclosed tag run (js/polynomial-redos)", async () => {
		vi.mocked(executeMcpTool).mockResolvedValueOnce({
			success: true,
			output: [
				{
					body: { html: `<${"a".repeat(50_000)}` },
					creator: { name: "Vlad" },
					created_at: "2026-06-18T09:20:00.000Z",
				},
			],
		} as never);
		await expect(fetchPmComments(baseInput)).resolves.toBeDefined();
	});

	it("fills the optional ADO `project` param so the comments tool does not elicit", async () => {
		vi.mocked(executeMcpTool).mockResolvedValueOnce({
			success: true,
			output: { comments: [] },
		} as never);
		await fetchPmComments({
			...baseInput,
			externalId: "239",
			containerId: "proj-guid",
			containerName: "Fabric",
			capabilities: {
				hasPMCapabilities: true,
				containerHierarchy: [],
				availableTools: [],
				detectedType: "azure-devops",
				taskComments: {
					toolName: "wit_list_work_item_comments",
					idParam: "workItemId",
					additionalRequiredParams: [],
					allParams: [
						{ name: "workItemId", type: "number", required: true },
						{ name: "project", type: "string", required: false },
					],
				},
			} as unknown as PMToolCapabilities,
		});
		const call = vi.mocked(executeMcpTool).mock.calls[0]![0] as {
			args: Record<string, unknown>;
		};
		expect(call.args).toMatchObject({ workItemId: 239, project: "Fabric" });
	});

	it("keeps only the most recent MAX_COMMENTS, in chronological order", async () => {
		const many = Array.from({ length: MAX_COMMENTS + 5 }, (_, i) => ({
			body: `c${i}`,
			created_at: `2026-05-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
		}));
		vi.mocked(executeMcpTool).mockResolvedValueOnce({
			success: true,
			output: { comments: many },
		} as never);
		const result = await fetchPmComments(baseInput);
		expect(result).toHaveLength(MAX_COMMENTS);
		// Oldest kept is c5; newest is c24; chronological asc in output.
		expect(result[0].body).toBe("c5");
		expect(result[result.length - 1].body).toBe(`c${MAX_COMMENTS + 4}`);
	});

	it("caps each comment body to MAX_CHARS_PER_COMMENT with an ellipsis", async () => {
		vi.mocked(executeMcpTool).mockResolvedValueOnce({
			success: true,
			output: {
				comments: [{ body: "x".repeat(MAX_CHARS_PER_COMMENT + 50) }],
			},
		} as never);
		const result = await fetchPmComments(baseInput);
		expect(result[0].body.length).toBe(MAX_CHARS_PER_COMMENT + 1); // +1 for "…"
		expect(result[0].body.endsWith("…")).toBe(true);
	});
});
