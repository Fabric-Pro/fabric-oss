import { ORPCError } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchCredentialsByProviderMock } = vi.hoisted(() => ({
	fetchCredentialsByProviderMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	fetchCredentialsByProvider: (...args: unknown[]) =>
		fetchCredentialsByProviderMock(...args),
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import {
	fetchConfluenceJson,
	fetchConfluencePageContent,
	getConfluenceCredentials,
	searchConfluencePages,
} from "../confluence-content";

describe("confluence-content lib", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		fetchMock.mockReset();
	});

	describe("getConfluenceCredentials", () => {
		it("throws NOT_FOUND when there is no connection", async () => {
			fetchCredentialsByProviderMock.mockResolvedValue(null);

			await expect(
				getConfluenceCredentials("user-1", "org-1"),
			).rejects.toThrow(
				new ORPCError("NOT_FOUND", {
					message: "Connect Confluence on the Integrations page",
				}),
			);
			expect(fetchCredentialsByProviderMock).toHaveBeenCalledWith(
				"CONFLUENCE",
				"user-1",
				"org-1",
			);
		});

		it("throws NOT_FOUND when credentials have missing fields", async () => {
			// Missing domain
			fetchCredentialsByProviderMock.mockResolvedValueOnce({
				CONFLUENCE_DOMAIN: "",
				CONFLUENCE_EMAIL: "dev@example.com",
				CONFLUENCE_API_TOKEN: "tok",
			});
			await expect(
				getConfluenceCredentials("user-1", "org-1"),
			).rejects.toThrow("Connect Confluence on the Integrations page");

			// Missing email
			fetchCredentialsByProviderMock.mockResolvedValueOnce({
				CONFLUENCE_DOMAIN: "example.atlassian.net",
				CONFLUENCE_EMAIL: "",
				CONFLUENCE_API_TOKEN: "tok",
			});
			await expect(
				getConfluenceCredentials("user-1", "org-1"),
			).rejects.toThrow("Connect Confluence on the Integrations page");

			// Missing API token
			fetchCredentialsByProviderMock.mockResolvedValueOnce({
				CONFLUENCE_DOMAIN: "example.atlassian.net",
				CONFLUENCE_EMAIL: "dev@example.com",
				CONFLUENCE_API_TOKEN: "",
			});
			await expect(
				getConfluenceCredentials("user-1", "org-1"),
			).rejects.toThrow("Connect Confluence on the Integrations page");
		});

		it("rejects invalid domains containing paths, fragments, queries, ports, or non-atlassian domains", async () => {
			const invalidDomains = [
				"attacker.invalid#example.atlassian.net",
				"example.atlassian.net/wiki/path",
				"example.atlassian.net?param=1",
				"admin@example.atlassian.net",
				"example.atlassian.net:8080",
				"internal-service.local",
				"malicious-atlassian.net.attacker.invalid",
			];

			for (const domain of invalidDomains) {
				fetchCredentialsByProviderMock.mockResolvedValueOnce({
					CONFLUENCE_DOMAIN: domain,
					CONFLUENCE_EMAIL: "dev@example.com",
					CONFLUENCE_API_TOKEN: "token",
				});

				await expect(
					getConfluenceCredentials("user-1", "org-1"),
				).rejects.toThrow(
					new ORPCError("BAD_REQUEST", {
						message:
							"Invalid Confluence domain. Expected *.atlassian.net",
					}),
				);
			}
		});

		it("returns normalized credentials for a valid connection", async () => {
			fetchCredentialsByProviderMock.mockResolvedValue({
				CONFLUENCE_DOMAIN: "example.atlassian.net/",
				CONFLUENCE_EMAIL: "dev@example.com",
				CONFLUENCE_API_TOKEN: "api-secret-123",
			});

			const creds = await getConfluenceCredentials("user-1", "org-1");
			expect(creds).toEqual({
				baseUrl: "https://example.atlassian.net",
				email: "dev@example.com",
				apiToken: "api-secret-123",
			});
		});
	});

	describe("fetchConfluenceJson", () => {
		const creds = {
			baseUrl: "https://example.atlassian.net",
			email: "dev@example.com",
			apiToken: "token-123",
		};

		it("maps 401 to UNAUTHORIZED", async () => {
			fetchMock.mockResolvedValueOnce({
				ok: false,
				status: 401,
				text: async () => "Unauthorized",
			});

			await expect(
				fetchConfluenceJson(creds, "/wiki/rest/api/test"),
			).rejects.toThrow(
				new ORPCError("UNAUTHORIZED", {
					message:
						"Confluence connection expired. Update your API token.",
				}),
			);
		});

		it("maps 403 to FORBIDDEN", async () => {
			fetchMock.mockResolvedValueOnce({
				ok: false,
				status: 403,
				text: async () => "Forbidden",
			});

			await expect(
				fetchConfluenceJson(creds, "/wiki/rest/api/test"),
			).rejects.toThrow(
				new ORPCError("FORBIDDEN", {
					message: "Confluence resource access forbidden",
				}),
			);
		});

		it("maps 404 to NOT_FOUND", async () => {
			fetchMock.mockResolvedValueOnce({
				ok: false,
				status: 404,
				text: async () => "Not Found",
			});

			await expect(
				fetchConfluenceJson(creds, "/wiki/rest/api/test"),
			).rejects.toThrow(
				new ORPCError("NOT_FOUND", {
					message: "Confluence resource not found",
				}),
			);
		});

		it("maps 500 to BAD_REQUEST without leaking error response body to client", async () => {
			fetchMock.mockResolvedValueOnce({
				ok: false,
				status: 500,
			});

			const consoleErrorSpy = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});

			await expect(
				fetchConfluenceJson(creds, "/wiki/rest/api/test"),
			).rejects.toThrow(
				new ORPCError("BAD_REQUEST", {
					message: "Confluence API request failed",
				}),
			);

			// Verify only status code was logged without leaking request/response content
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"[Confluence] API error (500)",
			);
			consoleErrorSpy.mockRestore();
		});

		it("returns parsed JSON on success with basic auth header", async () => {
			fetchMock.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ status: "ok" }),
			});

			const result = await fetchConfluenceJson<{ status: string }>(
				creds,
				"/wiki/rest/api/test",
			);
			expect(result).toEqual({ status: "ok" });
			expect(fetchMock).toHaveBeenCalledWith(
				"https://example.atlassian.net/wiki/rest/api/test",
				expect.objectContaining({
					headers: expect.objectContaining({
						Authorization: `Basic ${Buffer.from(`${creds.email}:${creds.apiToken}`).toString("base64")}`,
						Accept: "application/json",
					}),
				}),
			);
		});
	});

	describe("searchConfluencePages", () => {
		const creds = {
			baseUrl: "https://example.atlassian.net",
			email: "dev@example.com",
			apiToken: "token-123",
		};

		it("searches without a query using default lastmodified ordering", async () => {
			fetchMock.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					results: [
						{
							id: "101",
							title: "Architecture Guide",
							space: { key: "ENG", name: "Engineering" },
							version: { when: "2026-05-18T10:00:00.000Z" },
							_links: {
								webui: "/spaces/ENG/pages/101/Architecture+Guide",
							},
						},
					],
					totalSize: 1,
				}),
			});

			const { pages, nextCursor } = await searchConfluencePages(creds);

			expect(fetchMock).toHaveBeenCalledTimes(1);
			const requestedUrl = fetchMock.mock.calls[0][0] as string;
			expect(requestedUrl).toContain(
				`cql=${encodeURIComponent("type=page order by lastmodified desc")}`,
			);
			expect(requestedUrl).toContain("limit=50");
			expect(requestedUrl).toContain("start=0");
			expect(requestedUrl).toContain("expand=space,version");

			expect(pages).toEqual([
				{
					id: "101",
					title: "Architecture Guide",
					url: "https://example.atlassian.net/spaces/ENG/pages/101/Architecture+Guide",
					spaceKey: "ENG",
					spaceName: "Engineering",
					lastEdited: "2026-05-18T10:00:00.000Z",
				},
			]);
			expect(nextCursor).toBeNull();
		});

		it("searches with query and escapes quotes", async () => {
			fetchMock.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					results: [],
				}),
			});

			await searchConfluencePages(creds, 'Project "Apollo" Plan');

			expect(fetchMock).toHaveBeenCalledTimes(1);
			const requestedUrl = fetchMock.mock.calls[0][0] as string;
			const expectedCql =
				'type=page AND title ~ "Project \\"Apollo\\" Plan" order by lastmodified desc';
			expect(requestedUrl).toContain(
				`cql=${encodeURIComponent(expectedCql)}`,
			);
		});

		it("searches with query and escapes backslashes before quotes to prevent CQL injection", async () => {
			fetchMock.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					results: [],
				}),
			});

			await searchConfluencePages(creds, 'x\\" OR title ~ "hack');

			expect(fetchMock).toHaveBeenCalledTimes(1);
			const requestedUrl = fetchMock.mock.calls[0][0] as string;
			const expectedCql =
				'type=page AND title ~ "x\\\\\\" OR title ~ \\"hack" order by lastmodified desc';
			expect(requestedUrl).toContain(
				`cql=${encodeURIComponent(expectedCql)}`,
			);
		});

		it("handles pagination and returns nextCursor when more results exist", async () => {
			fetchMock.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					results: Array.from({ length: 50 }, (_, i) => ({
						id: String(i + 1),
						title: `Page ${i + 1}`,
					})),
					_links: { next: "/next-page" },
					totalSize: 100,
				}),
			});

			const { pages, nextCursor } = await searchConfluencePages(
				creds,
				undefined,
				"0",
			);
			expect(pages).toHaveLength(50);
			expect(nextCursor).toBe("50");
		});

		it("uses cursor offset as start parameter and calculates nextCursor", async () => {
			fetchMock.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					results: Array.from({ length: 30 }, (_, i) => ({
						id: String(i + 51),
						title: `Page ${i + 51}`,
					})),
					totalSize: 80,
				}),
			});

			const { pages, nextCursor } = await searchConfluencePages(
				creds,
				undefined,
				"50",
			);
			const requestedUrl = fetchMock.mock.calls[0][0] as string;
			expect(requestedUrl).toContain("start=50");
			expect(pages).toHaveLength(30);
			expect(nextCursor).toBeNull();
		});
	});

	describe("fetchConfluencePageContent", () => {
		const creds = {
			baseUrl: "https://example.atlassian.net",
			email: "dev@example.com",
			apiToken: "token-123",
		};

		it("fetches page storage XHTML and converts to markdown", async () => {
			fetchMock.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					id: "123",
					body: {
						storage: {
							value: '<h1>API Overview</h1><p>This is a <strong>test</strong> with <a href="https://example.com">link</a>.</p>',
						},
					},
				}),
			});

			const markdown = await fetchConfluencePageContent(creds, "123");
			expect(fetchMock).toHaveBeenCalledWith(
				"https://example.atlassian.net/wiki/rest/api/content/123?expand=body.storage",
				expect.anything(),
			);
			expect(markdown).toContain("# API Overview");
			expect(markdown).toContain(
				"This is a **test** with [link](https://example.com).",
			);
		});

		it("rejects page content exceeding the 2 MB limit", async () => {
			const oversizedContent = "a".repeat(2 * 1024 * 1024 + 1);
			fetchMock.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					id: "oversized-1",
					body: {
						storage: {
							value: oversizedContent,
						},
					},
				}),
			});

			await expect(
				fetchConfluencePageContent(creds, "oversized-1"),
			).rejects.toThrow(
				new ORPCError("BAD_REQUEST", {
					message:
						"Confluence page is too large to import (exceeds 2 MB limit)",
				}),
			);
		});
	});
});
