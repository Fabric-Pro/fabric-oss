import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	return { handlers };
});

vi.mock("@repo/database", () => ({
	getDataConnectionById: vi.fn(),
}));

vi.mock("../../../../orpc/procedures", () => {
	return {
		tenantProtectedProcedure: {
			use: () => ({
				route: (routeInfo: { path: string }) => ({
					input: (schema?: any) => ({
						handler: (fn: (...args: unknown[]) => unknown) => {
							const wrapped = async (args: any) => {
								if (schema && args?.input) {
									const parsed = schema.safeParse(args.input);
									if (!parsed.success) {
										throw new ORPCError("BAD_REQUEST", {
											message: "Validation failed",
											data: parsed.error,
										});
									}
								}
								return fn(args);
							};
							if (routeInfo.path.endsWith("/content")) {
								handlers.pageContent = wrapped;
							} else {
								handlers.pages = wrapped;
							}
							return { _handler: wrapped };
						},
					}),
				}),
			}),
		},
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null | undefined) =>
				organizationId ?? undefined,
		),
	};
});

vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../lib/notion-content", () => ({
	fetchNotionBlocksAsText: vi.fn(),
}));

import { getDataConnectionById } from "@repo/database";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";
import { fetchNotionBlocksAsText } from "../../lib/notion-content";
import "../notion";

const context = {
	user: { id: "user-1" },
	session: { activeOrganizationId: "org-1" },
};

describe("notion procedures", () => {
	const originalFetch = global.fetch;

	beforeEach(() => {
		vi.clearAllMocks();
		global.fetch = originalFetch;
	});

	describe("notion.pages", () => {
		it("lists pages and returns pagination nextCursor", async () => {
			vi.mocked(getDataConnectionById).mockResolvedValue({
				id: "conn-1",
				provider: "NOTION",
				accessToken: "notion-token-123",
				userId: "user-1",
				organizationId: "org-1",
			} as any);

			global.fetch = vi
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({
						results: [
							{
								object: "page",
								id: "p1",
								url: "https://notion.so/p1",
								last_edited_time: "2026-10-21T00:00:00.000Z",
								icon: { type: "emoji", emoji: "📄" },
								properties: {
									title: {
										type: "title",
										title: [{ plain_text: "My Page" }],
									},
								},
							},
						],
						has_more: true,
						next_cursor: "next-cursor-step2",
					}),
				} as any)
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({
						results: [
							{
								object: "page",
								id: "p2",
								url: "https://notion.so/p2",
								last_edited_time: "2026-10-21T01:00:00.000Z",
								icon: null,
								properties: {
									title: {
										type: "title",
										title: [{ plain_text: "Second Page" }],
									},
								},
							},
						],
						has_more: true,
						next_cursor: "next-cursor-final",
					}),
				} as any);

			const result = (await handlers.pages({
				input: {
					id: "conn-1",
					organizationId: "org-1",
					query: "test",
					cursor: "initial-cursor",
				},
				context,
			})) as { pages: any[]; nextCursor: string | null };

			expect(result.pages).toEqual([
				{
					id: "p1",
					title: "My Page",
					url: "https://notion.so/p1",
					lastEdited: "2026-10-21T00:00:00.000Z",
					icon: "📄",
				},
				{
					id: "p2",
					title: "Second Page",
					url: "https://notion.so/p2",
					lastEdited: "2026-10-21T01:00:00.000Z",
					icon: null,
				},
			]);
			expect(result.nextCursor).toBe("next-cursor-final");

			expect(global.fetch).toHaveBeenCalledWith(
				"https://api.notion.com/v1/search",
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({
						filter: { value: "page", property: "object" },
						page_size: 50,
						query: "test",
						start_cursor: "initial-cursor",
					}),
				}),
			);
		});

		it("throws UNAUTHORIZED when Notion returns 401", async () => {
			vi.mocked(getDataConnectionById).mockResolvedValue({
				id: "conn-1",
				provider: "NOTION",
				accessToken: "expired-token",
				userId: "user-1",
				organizationId: "org-1",
			} as any);

			global.fetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 401,
				text: async () => "Unauthorized",
			} as any);

			await expect(
				handlers.pages({
					input: { id: "conn-1", organizationId: "org-1" },
					context,
				}),
			).rejects.toMatchObject({
				code: "UNAUTHORIZED",
				message: "Notion connection expired. Reconnect Notion.",
			});
		});

		it("throws FORBIDDEN when user is not an organization member", async () => {
			vi.mocked(verifyOrganizationMembership).mockResolvedValueOnce(
				false,
			);

			await expect(
				handlers.pages({
					input: { id: "conn-1", organizationId: "org-1" },
					context,
				}),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
		});

		it("throws NOT_FOUND when connection does not exist", async () => {
			vi.mocked(getDataConnectionById).mockResolvedValue(null);

			await expect(
				handlers.pages({
					input: { id: "conn-1", organizationId: "org-1" },
					context,
				}),
			).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
		});

		it("throws BAD_REQUEST when connection is not NOTION", async () => {
			vi.mocked(getDataConnectionById).mockResolvedValue({
				id: "conn-1",
				provider: "GOOGLE_DRIVE",
				accessToken: "token",
			} as any);

			await expect(
				handlers.pages({
					input: { id: "conn-1", organizationId: "org-1" },
					context,
				}),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: "This connection is not a Notion connection",
			});
		});
	});

	describe("notion.pageContent", () => {
		it("fetches page content and returns { content }", async () => {
			vi.mocked(getDataConnectionById).mockResolvedValue({
				id: "conn-1",
				provider: "NOTION",
				accessToken: "notion-token-123",
				userId: "user-1",
				organizationId: "org-1",
			} as any);

			vi.mocked(fetchNotionBlocksAsText).mockResolvedValueOnce(
				"# Welcome\n\nPage body text.",
			);

			const result = (await handlers.pageContent({
				input: {
					id: "conn-1",
					pageId: "12345678-1234-1234-1234-123456789abc",
					organizationId: "org-1",
				},
				context,
			})) as { content: string };

			expect(result.content).toBe("# Welcome\n\nPage body text.");
			expect(fetchNotionBlocksAsText).toHaveBeenCalledWith(
				"12345678-1234-1234-1234-123456789abc",
				"notion-token-123",
			);
		});

		it("throws FORBIDDEN when user is not an organization member", async () => {
			vi.mocked(verifyOrganizationMembership).mockResolvedValueOnce(
				false,
			);

			await expect(
				handlers.pageContent({
					input: {
						id: "conn-1",
						pageId: "12345678-1234-1234-1234-123456789abc",
						organizationId: "org-1",
					},
					context,
				}),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
		});

		it("throws NOT_FOUND when connection is missing", async () => {
			vi.mocked(getDataConnectionById).mockResolvedValue(null);

			await expect(
				handlers.pageContent({
					input: {
						id: "conn-1",
						pageId: "12345678-1234-1234-1234-123456789abc",
						organizationId: "org-1",
					},
					context,
				}),
			).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
		});

		it("propagates error from fetchNotionBlocksAsText", async () => {
			vi.mocked(getDataConnectionById).mockResolvedValue({
				id: "conn-1",
				provider: "NOTION",
				accessToken: "notion-token-123",
			} as any);

			vi.mocked(fetchNotionBlocksAsText).mockRejectedValueOnce(
				new ORPCError("UNAUTHORIZED", {
					message: "Notion connection expired. Reconnect Notion.",
				}),
			);

			await expect(
				handlers.pageContent({
					input: {
						id: "conn-1",
						pageId: "12345678-1234-1234-1234-123456789abc",
						organizationId: "org-1",
					},
					context,
				}),
			).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
		});

		it("rejects invalid pageId such as path traversal or malformed string", async () => {
			await expect(
				handlers.pageContent({
					input: {
						id: "conn-1",
						pageId: "../x",
						organizationId: "org-1",
					},
					context,
				}),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
			expect(getDataConnectionById).not.toHaveBeenCalled();
		});
	});
});
