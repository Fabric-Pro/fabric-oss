import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	return { handlers };
});

const {
	mockGetConfluenceCredentials,
	mockSearchConfluencePages,
	mockFetchConfluencePageContent,
	mockResolveOrganizationId,
} = vi.hoisted(() => ({
	mockGetConfluenceCredentials: vi.fn(),
	mockSearchConfluencePages: vi.fn(),
	mockFetchConfluencePageContent: vi.fn(),
	mockResolveOrganizationId: vi.fn(
		(organizationId: string | null | undefined, _session: unknown) =>
			organizationId ?? "org-resolved",
	),
}));

vi.mock("../../../../orpc/procedures", () => {
	return {
		tenantProtectedProcedure: {
			use: () => ({
				route: (routeInfo: { path: string }) => ({
					input: (schema?: any) => ({
						output: () => ({
							handler: (fn: (...args: unknown[]) => unknown) => {
								const wrapped = async (args: any) => {
									if (schema && args?.input) {
										const parsed = schema.safeParse(
											args.input,
										);
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
			}),
		},
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireInputOrgPermission: () => (c: unknown) => c,
		resolveOrganizationId: mockResolveOrganizationId,
	};
});

vi.mock("../../lib/confluence-content", () => ({
	getConfluenceCredentials: mockGetConfluenceCredentials,
	searchConfluencePages: mockSearchConfluencePages,
	fetchConfluencePageContent: mockFetchConfluencePageContent,
}));

import "../confluence-pages";

const context = {
	user: { id: "user-123" },
	session: { activeOrganizationId: "org-resolved" },
};

describe("confluence pages procedures", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("confluence.pages", () => {
		it("resolves credentials and returns searched pages with cursor", async () => {
			const fakeCreds = {
				baseUrl: "https://example.atlassian.net",
				email: "dev@example.com",
				apiToken: "secret-token",
			};
			mockGetConfluenceCredentials.mockResolvedValueOnce(fakeCreds);
			mockSearchConfluencePages.mockResolvedValueOnce({
				pages: [
					{
						id: "123",
						title: "Architecture Guide",
						url: "https://example.atlassian.net/wiki/spaces/ENG/pages/123",
						spaceKey: "ENG",
						spaceName: "Engineering",
						lastEdited: "2026-10-27T00:00:00.000Z",
					},
				],
				nextCursor: "50",
			});

			const pagesHandler = handlers.pages;
			expect(pagesHandler).toBeDefined();

			const result = await pagesHandler({
				input: {
					organizationId: "org-1",
					query: "Architecture",
					cursor: "0",
				},
				context,
			});

			expect(mockResolveOrganizationId).toHaveBeenCalledWith(
				"org-1",
				context.session,
			);
			expect(mockGetConfluenceCredentials).toHaveBeenCalledWith(
				"user-123",
				"org-1",
			);
			expect(mockSearchConfluencePages).toHaveBeenCalledWith(
				fakeCreds,
				"Architecture",
				"0",
			);
			expect(result).toEqual({
				pages: [
					{
						id: "123",
						title: "Architecture Guide",
						url: "https://example.atlassian.net/wiki/spaces/ENG/pages/123",
						spaceKey: "ENG",
						spaceName: "Engineering",
						lastEdited: "2026-10-27T00:00:00.000Z",
					},
				],
				nextCursor: "50",
			});
		});

		it("handles optional query and cursor", async () => {
			const fakeCreds = {
				baseUrl: "https://example.atlassian.net",
				email: "dev@example.com",
				apiToken: "secret-token",
			};
			mockGetConfluenceCredentials.mockResolvedValueOnce(fakeCreds);
			mockSearchConfluencePages.mockResolvedValueOnce({
				pages: [],
				nextCursor: null,
			});

			const pagesHandler = handlers.pages;
			const result = await pagesHandler({
				input: {},
				context,
			});

			expect(mockSearchConfluencePages).toHaveBeenCalledWith(
				fakeCreds,
				undefined,
				undefined,
			);
			expect(result).toEqual({
				pages: [],
				nextCursor: null,
			});
		});

		it("rejects query exceeding 200 characters with validation error", async () => {
			const pagesHandler = handlers.pages;
			await expect(
				pagesHandler({
					input: {
						query: "a".repeat(201),
					},
					context,
				}),
			).rejects.toThrow(ORPCError);
		});
	});

	describe("confluence.pageContent", () => {
		it("resolves credentials and returns converted markdown content", async () => {
			const fakeCreds = {
				baseUrl: "https://example.atlassian.net",
				email: "dev@example.com",
				apiToken: "secret-token",
			};
			mockGetConfluenceCredentials.mockResolvedValueOnce(fakeCreds);
			mockFetchConfluencePageContent.mockResolvedValueOnce(
				"# Confluence Markdown Content\n\nSome body text.",
			);

			const pageContentHandler = handlers.pageContent;
			expect(pageContentHandler).toBeDefined();

			const result = await pageContentHandler({
				input: {
					organizationId: "org-1",
					pageId: "456789",
				},
				context,
			});

			expect(mockGetConfluenceCredentials).toHaveBeenCalledWith(
				"user-123",
				"org-1",
			);
			expect(mockFetchConfluencePageContent).toHaveBeenCalledWith(
				fakeCreds,
				"456789",
			);
			expect(result).toEqual({
				content: "# Confluence Markdown Content\n\nSome body text.",
			});
		});

		it("rejects non-numeric pageId with validation error", async () => {
			const pageContentHandler = handlers.pageContent;

			await expect(
				pageContentHandler({
					input: {
						pageId: "abc-invalid-id",
					},
					context,
				}),
			).rejects.toThrow(ORPCError);
		});
	});
});
