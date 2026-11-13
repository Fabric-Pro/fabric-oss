// @vitest-environment node
// Real tokens are signed and verified here; jose rejects the Uint8Array that
// jsdom's TextEncoder returns.

import { issueAIToken } from "@repo/ai-token";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const SECRET = "test-secret-for-web-research-tools-route";
const USER_ID = "user-1";
const ORG_ID = "org-1";
const PROJECT_ID = "project-1";

const getProjectAccessContext = vi.fn();
const isProjectSoftDeleted = vi.fn();
const incrementOrganizationSearchProviderUsage = vi.fn();
const organizationFindUnique = vi.fn();
const projectFindUnique = vi.fn();
const memberFindMany = vi.fn();
vi.mock("@repo/database", () => ({
	db: {
		organization: {
			findUnique: (args: unknown) => organizationFindUnique(args),
		},
		project: { findUnique: (args: unknown) => projectFindUnique(args) },
		member: { findMany: (args: unknown) => memberFindMany(args) },
	},
	getProjectAccessContext: (...args: unknown[]) =>
		getProjectAccessContext(...args),
	isProjectSoftDeleted: (...args: unknown[]) => isProjectSoftDeleted(...args),
	incrementOrganizationSearchProviderUsage: (...args: unknown[]) =>
		incrementOrganizationSearchProviderUsage(...args),
}));

const checkRateLimit = vi.fn();
vi.mock("@repo/api/lib/rate-limit", () => ({
	checkRateLimit: (...args: unknown[]) => checkRateLimit(...args),
}));

const getWebResearchSearcher = vi.fn();
const getWebResearchScraper = vi.fn();
vi.mock("@repo/temporal/activities", () => ({
	getWebResearchSearcher: (...args: unknown[]) =>
		getWebResearchSearcher(...args),
	getWebResearchScraper: (...args: unknown[]) =>
		getWebResearchScraper(...args),
}));

const loggerInfo = vi.fn();
const loggerError = vi.fn();
vi.mock("@repo/logs", () => ({
	logger: {
		info: (...args: unknown[]) => loggerInfo(...args),
		error: (...args: unknown[]) => loggerError(...args),
		warn: vi.fn(),
	},
}));

const search = vi.fn();
const scrapeUrl = vi.fn();

async function token(
	options: {
		webResearch?: boolean;
		webResearchProjectId?: string;
		webResearchGrantId?: string;
		organizationId?: string | null;
		secret?: string;
	} = {},
): Promise<string> {
	const previous = process.env.AI_TOKEN_SECRET;
	process.env.AI_TOKEN_SECRET = options.secret ?? SECRET;
	try {
		return await issueAIToken({
			userId: USER_ID,
			organizationId:
				options.organizationId === null
					? undefined
					: (options.organizationId ?? ORG_ID),
			source: "document-generator",
			impersonated: false,
			webResearch: options.webResearch ?? true,
			webResearchProjectId: options.webResearchProjectId,
			webResearchGrantId: options.webResearchGrantId,
		});
	} finally {
		process.env.AI_TOKEN_SECRET = previous;
	}
}

async function call(body: unknown, aiToken?: string | null) {
	const headers = new Headers({ "content-type": "application/json" });
	const value = aiToken === undefined ? await token() : aiToken;
	if (value) {
		headers.set("X-AI-Token", value);
	}
	const { POST } = await import("../route");
	const response = await POST(
		new Request("https://example.test/api/internal/web-research-tools", {
			method: "POST",
			headers,
			body: typeof body === "string" ? body : JSON.stringify(body),
		}),
	);
	return { status: response.status, body: await response.json() };
}

const searchBody = (args: Record<string, unknown>) => ({
	toolName: "web_search",
	projectId: PROJECT_ID,
	args,
});
const readBody = (url: string) => ({
	toolName: "read_url",
	projectId: PROJECT_ID,
	args: { url },
});

function expectNoProviderCalls() {
	expect(getWebResearchSearcher).not.toHaveBeenCalled();
	expect(getWebResearchScraper).not.toHaveBeenCalled();
	expect(search).not.toHaveBeenCalled();
	expect(scrapeUrl).not.toHaveBeenCalled();
}

beforeAll(() => {
	process.env.AI_TOKEN_SECRET = SECRET;
});

beforeEach(() => {
	vi.clearAllMocks();
	process.env.AI_TOKEN_SECRET = SECRET;
	getProjectAccessContext.mockResolvedValue({ organizationId: ORG_ID });
	isProjectSoftDeleted.mockResolvedValue(false);
	incrementOrganizationSearchProviderUsage.mockResolvedValue({});
	organizationFindUnique.mockResolvedValue({
		name: "Example Org Holdings",
		slug: "example-org",
	});
	projectFindUnique.mockResolvedValue({
		name: "Northwind Migration",
		recipientBrand: { name: "Contoso", website: "https://contoso.example" },
	});
	memberFindMany.mockResolvedValue([{ user: { email: "dev@example.com" } }]);
	search.mockResolvedValue([
		{
			title: "Cloud ROI study",
			url: "https://research.example.net/cloud-roi",
			snippet: "Average payback of 14 months.",
			content: "FULL PAGE BODY",
			source: "exa",
		},
	]);
	scrapeUrl.mockResolvedValue({
		success: true,
		data: {
			pageUrl: "https://news.example.net/report",
			pageTitle: "Report",
			markdown: "Readable page text.",
		},
	});
	getWebResearchSearcher.mockResolvedValue({
		searcher: { providerName: "exa", search },
	});
	getWebResearchScraper.mockResolvedValue({
		scraper: { providerName: "firecrawl", scrapeUrl },
	});
	checkRateLimit.mockResolvedValue({
		allowed: true,
		remaining: 5,
		resetInSeconds: 60,
	});
});

afterEach(() => {
	vi.useRealTimers();
});

describe("POST /api/internal/web-research-tools — authentication", () => {
	it("answers 401 without a token", async () => {
		const { status, body } = await call(searchBody({ query: "q" }), null);

		expect(status).toBe(401);
		expect(body).toMatchObject({ ok: false, code: "INVALID_TOKEN" });
		expectNoProviderCalls();
	});

	it("answers 401 for a malformed token", async () => {
		const { status, body } = await call(
			searchBody({ query: "q" }),
			"not.a.token",
		);

		expect(status).toBe(401);
		expect(body.code).toBe("INVALID_TOKEN");
	});

	it("answers 401 for a research token signed with another secret", async () => {
		const forged = await token({ secret: "some-other-secret-value" });

		const { status, body } = await call(searchBody({ query: "q" }), forged);

		expect(status).toBe(401);
		expect(body.code).toBe("INVALID_TOKEN");
		expectNoProviderCalls();
	});

	it("answers 401 for an expired research token", async () => {
		const expired = await token();
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.now() + 60 * 60 * 1000);

		const { status, body } = await call(
			searchBody({ query: "q" }),
			expired,
		);

		expect(status).toBe(401);
		expect(body.code).toBe("INVALID_TOKEN");
		expectNoProviderCalls();
	});
});

describe("POST /api/internal/web-research-tools — authorization", () => {
	it("answers 403 RESEARCH_NOT_AUTHORIZED for a token without the research claim, before any other work", async () => {
		const plain = await token({ webResearch: false });

		const { status, body } = await call(searchBody({ query: "q" }), plain);

		expect(status).toBe(403);
		expect(body).toMatchObject({
			ok: false,
			code: "RESEARCH_NOT_AUTHORIZED",
		});
		expect(getProjectAccessContext).not.toHaveBeenCalled();
		expectNoProviderCalls();
	});

	it("answers 403 RESEARCH_NOT_AUTHORIZED for read_url too", async () => {
		const plain = await token({ webResearch: false });

		const { status } = await call(
			readBody("https://news.example.net/"),
			plain,
		);

		expect(status).toBe(403);
		expectNoProviderCalls();
	});

	it("checks the research claim before the body, so a malformed request without it gets 403", async () => {
		const plain = await token({ webResearch: false });

		const { status, body } = await call({ toolName: "fetch" }, plain);

		expect(status).toBe(403);
		expect(body.code).toBe("RESEARCH_NOT_AUTHORIZED");
	});

	it("refuses a research token without an organization", async () => {
		const orgless = await token({ organizationId: null });

		const { status, body } = await call(
			searchBody({ query: "q" }),
			orgless,
		);

		expect(status).toBe(403);
		expect(body.code).toBe("PROJECT_ACCESS_DENIED");
		expect(getProjectAccessContext).not.toHaveBeenCalled();
		expectNoProviderCalls();
	});

	it("refuses a caller without access to the project", async () => {
		getProjectAccessContext.mockResolvedValue(null);

		const { status, body } = await call(searchBody({ query: "q" }));

		expect(status).toBe(403);
		expect(body.code).toBe("PROJECT_ACCESS_DENIED");
		expect(getProjectAccessContext).toHaveBeenCalledWith(
			PROJECT_ID,
			USER_ID,
		);
		expectNoProviderCalls();
	});

	it("refuses a project of another organization", async () => {
		getProjectAccessContext.mockResolvedValue({
			organizationId: "org-other",
		});

		const { status, body } = await call(searchBody({ query: "q" }));

		expect(status).toBe(403);
		expect(body.code).toBe("PROJECT_ACCESS_DENIED");
		expectNoProviderCalls();
	});

	it("refuses a project in the trash", async () => {
		isProjectSoftDeleted.mockResolvedValue(true);

		const { status, body } = await call(searchBody({ query: "q" }));

		expect(status).toBe(403);
		expect(body.code).toBe("PROJECT_ACCESS_DENIED");
		expectNoProviderCalls();
	});

	it("refuses a project other than the one the permission was given for", async () => {
		const otherProject = await token({ webResearchProjectId: "project-2" });

		const { status, body } = await call(
			searchBody({ query: "cloud ROI" }),
			otherProject,
		);

		expect(status).toBe(403);
		expect(body.code).toBe("PROJECT_ACCESS_DENIED");
		expect(getProjectAccessContext).not.toHaveBeenCalled();
		expectNoProviderCalls();
	});

	it("serves the project the permission was given for", async () => {
		const sameProject = await token({ webResearchProjectId: PROJECT_ID });

		const { status } = await call(
			searchBody({ query: "cloud ROI" }),
			sameProject,
		);

		expect(status).toBe(200);
	});

	it("uses the token's organization, never one from the body", async () => {
		await call({
			...searchBody({ query: "cloud ROI" }),
			organizationId: "org-other",
		});

		expect(getWebResearchSearcher).toHaveBeenCalledWith(USER_ID, ORG_ID);
		expect(incrementOrganizationSearchProviderUsage).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: ORG_ID }),
		);
	});
});

describe("POST /api/internal/web-research-tools — request validation", () => {
	it.each([
		[
			"an unknown tool",
			{ toolName: "fetch", projectId: PROJECT_ID, args: {} },
		],
		[
			"a missing projectId",
			{ toolName: "web_search", args: { query: "q" } },
		],
		["an empty query", searchBody({ query: "   " })],
		["a query over 400 characters", searchBody({ query: "a".repeat(401) })],
		[
			"a non-number maxResults",
			searchBody({ query: "q", maxResults: "5" }),
		],
		[
			"a missing url",
			{ toolName: "read_url", projectId: PROJECT_ID, args: {} },
		],
		["a body that is not JSON", "{not json"],
	])("answers 400 INVALID_REQUEST for %s", async (_label, body) => {
		const { status, body: response } = await call(body);

		expect(status).toBe(400);
		expect(response).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
		expect(getProjectAccessContext).not.toHaveBeenCalled();
		expectNoProviderCalls();
	});
});

describe("POST /api/internal/web-research-tools — providers", () => {
	it("answers 409 when the organization has no search provider", async () => {
		getWebResearchSearcher.mockResolvedValue({ unavailable: "none" });

		const { status, body } = await call(searchBody({ query: "q" }));

		expect(status).toBe(409);
		expect(body.code).toBe("RESEARCH_UNAVAILABLE");
	});

	it("answers 409 when the organization has no page reader", async () => {
		getWebResearchScraper.mockResolvedValue({ unavailable: "none" });

		const { status, body } = await call(
			readBody("https://news.example.net/"),
		);

		expect(status).toBe(409);
		expect(body.code).toBe("RESEARCH_UNAVAILABLE");
		expect(getWebResearchScraper).toHaveBeenCalledWith({
			userId: USER_ID,
			organizationId: ORG_ID,
		});
	});

	it("answers 500, not 409, when resolving the provider throws", async () => {
		getWebResearchScraper.mockRejectedValue(new Error("decrypt failed"));

		const { status, body } = await call(
			readBody("https://news.example.net/"),
		);

		expect(status).toBe(500);
		expect(body).toEqual({
			ok: false,
			code: "INTERNAL_ERROR",
			message: expect.any(String),
		});
		expect(body.message).not.toContain("decrypt");
	});

	it("answers 500 when resolving the search provider throws", async () => {
		getWebResearchSearcher.mockRejectedValue(new Error("db down"));

		const { status, body } = await call(searchBody({ query: "cloud ROI" }));

		expect(status).toBe(500);
		expect(body.code).toBe("INTERNAL_ERROR");
	});

	it("answers 500 and calls no provider when the access check throws", async () => {
		getProjectAccessContext.mockRejectedValue(new Error("db down"));

		const { status, body } = await call(searchBody({ query: "cloud ROI" }));

		expect(status).toBe(500);
		expect(body.code).toBe("INTERNAL_ERROR");
		expectNoProviderCalls();
	});

	it("resolves only the provider the tool needs", async () => {
		await call(searchBody({ query: "cloud ROI" }));
		expect(getWebResearchScraper).not.toHaveBeenCalled();

		vi.clearAllMocks();
		getWebResearchScraper.mockResolvedValue({
			scraper: { providerName: "firecrawl", scrapeUrl },
		});
		await call(readBody("https://news.example.net/report"));
		expect(getWebResearchSearcher).not.toHaveBeenCalled();
	});
});

describe("POST /api/internal/web-research-tools — unusable provider key", () => {
	const KEY_ERROR_TEXT = "Unsupported state or unable to authenticate data";

	function expectNoSecretText(body: unknown) {
		const everything = JSON.stringify([
			body,
			loggerInfo.mock.calls,
			loggerError.mock.calls,
		]);
		expect(everything).not.toContain(KEY_ERROR_TEXT);
		expect(everything).not.toContain("example-encrypted-key");
	}

	it("answers 409 RESEARCH_PROVIDER_UNUSABLE for a search key that cannot be used", async () => {
		getWebResearchSearcher.mockResolvedValue({
			unavailable: "unusable",
			providerName: "tavily",
			reason: "key_unreadable",
		});

		const { status, body } = await call(searchBody({ query: "cloud ROI" }));

		expect(status).toBe(409);
		expect(body).toEqual({
			ok: false,
			code: "RESEARCH_PROVIDER_UNUSABLE",
			message: expect.stringContaining("re-enter"),
		});
		expect(body.message).toContain("organization admin");
		expect(search).not.toHaveBeenCalled();
		expect(loggerInfo).toHaveBeenCalledWith(
			"[web-research-tools] call",
			expect.objectContaining({
				tool: "web_search",
				provider: "tavily",
				errorKind: "key_unreadable",
				code: "RESEARCH_PROVIDER_UNUSABLE",
				status: 409,
			}),
		);
		expectNoSecretText(body);
	});

	it("answers 409 RESEARCH_PROVIDER_UNUSABLE for a page-reading key that cannot be used", async () => {
		getWebResearchScraper.mockResolvedValue({
			unavailable: "unusable",
			providerName: "firecrawl",
			reason: "key_unreadable",
		});

		const { status, body } = await call(
			readBody("https://news.example.net/report"),
		);

		expect(status).toBe(409);
		expect(body.code).toBe("RESEARCH_PROVIDER_UNUSABLE");
		expect(body.message).toContain("re-enter");
		expect(scrapeUrl).not.toHaveBeenCalled();
		expect(loggerInfo).toHaveBeenCalledWith(
			"[web-research-tools] call",
			expect.objectContaining({
				tool: "read_url",
				provider: "firecrawl",
				errorKind: "key_unreadable",
			}),
		);
		expectNoSecretText(body);
	});

	it("asks for the provider's settings to be fixed, not its key, when the provider cannot be built", async () => {
		getWebResearchScraper.mockResolvedValue({
			unavailable: "unusable",
			providerName: "cloudflare",
			reason: "provider_unusable",
		});

		const { status, body } = await call(
			readBody("https://news.example.net/report"),
		);

		expect(status).toBe(409);
		expect(body).toEqual({
			ok: false,
			code: "RESEARCH_PROVIDER_UNUSABLE",
			message: expect.stringContaining(
				"An organization admin needs to fix this provider's settings in the search provider settings.",
			),
		});
		expect(body.message).not.toContain("re-enter");
		expect(body.message).not.toContain("key");
		expect(scrapeUrl).not.toHaveBeenCalled();
		expect(loggerInfo).toHaveBeenCalledWith(
			"[web-research-tools] call",
			expect.objectContaining({
				tool: "read_url",
				provider: "cloudflare",
				errorKind: "provider_unusable",
				code: "RESEARCH_PROVIDER_UNUSABLE",
				status: 409,
			}),
		);
	});

	it.each([
		["search", () => searchBody({ query: "cloud ROI" })],
		["read", () => readBody("https://news.example.net/report")],
	])(
		"keeps RESEARCH_UNAVAILABLE for %s when no provider is configured at all",
		async (_label, body) => {
			getWebResearchSearcher.mockResolvedValue({ unavailable: "none" });
			getWebResearchScraper.mockResolvedValue({ unavailable: "none" });

			const { status, body: response } = await call(body());

			expect(status).toBe(409);
			expect(response.code).toBe("RESEARCH_UNAVAILABLE");
		},
	);

	it.each([
		[
			"search",
			() => getWebResearchSearcher,
			() => searchBody({ query: "cloud ROI" }),
		],
		[
			"read",
			() => getWebResearchScraper,
			() => readBody("https://news.example.net/report"),
		],
	])(
		"answers 500 without the error text when reading the %s provider rows throws",
		async (_label, resolver, body) => {
			resolver().mockRejectedValue(
				new Error(`${KEY_ERROR_TEXT}: example-encrypted-key`),
			);

			const { status, body: response } = await call(body());

			expect(status).toBe(500);
			expect(response.code).toBe("INTERNAL_ERROR");
			expectNoSecretText(response);
		},
	);
});

describe("POST /api/internal/web-research-tools — per-action research cap", () => {
	it.each([
		["web_search", () => searchBody({ query: "cloud ROI" }), 10],
		["read_url", () => readBody("https://news.example.net/report"), 16],
	])(
		"counts %s against the action's grant, at twice the agent's limit over two hours",
		async (toolName, body, cap) => {
			const { status } = await call(
				body(),
				await token({ webResearchGrantId: "grant-1" }),
			);

			expect(status).toBe(200);
			expect(checkRateLimit).toHaveBeenCalledWith(
				`web-research:grant-1:${toolName}`,
				cap,
				2 * 60 * 60 * 1000,
			);
		},
	);

	it("counts a token without a grant on its own nonce", async () => {
		const aiToken = await token();
		const { jti } = JSON.parse(
			Buffer.from(aiToken.split(".")[1] ?? "", "base64url").toString(),
		) as { jti: string };

		await call(searchBody({ query: "cloud ROI" }), aiToken);

		expect(jti).toMatch(/\S/);
		expect(checkRateLimit).toHaveBeenCalledWith(
			`web-research:${jti}:web_search`,
			10,
			2 * 60 * 60 * 1000,
		);
	});

	it.each([
		["search", () => searchBody({ query: "cloud ROI" })],
		["read", () => readBody("https://news.example.net/report")],
	])(
		"answers 429 RESEARCH_LIMIT_REACHED for %s once the grant's calls are spent",
		async (_label, body) => {
			checkRateLimit.mockResolvedValue({
				allowed: false,
				remaining: 0,
				resetInSeconds: 600,
			});

			const { status, body: response } = await call(body());

			expect(status).toBe(429);
			expect(response).toEqual({
				ok: false,
				code: "RESEARCH_LIMIT_REACHED",
				message: expect.stringContaining("limit is reached"),
			});
			expectNoProviderCalls();
		},
	);

	it("proceeds and logs ids only when the limiter is unavailable", async () => {
		checkRateLimit.mockResolvedValue({
			allowed: false,
			remaining: 0,
			resetInSeconds: 60,
			statusCode: 503,
			reason: "ratelimit-unavailable",
		});
		const aiToken = await token({ webResearchGrantId: "grant-1" });

		const { status } = await call(
			searchBody({ query: "cloud ROI" }),
			aiToken,
		);

		expect(status).toBe(200);
		expect(search).toHaveBeenCalledTimes(1);
		expect(loggerError).toHaveBeenCalledWith(
			"[web-research-tools] research cap unavailable",
			{
				tool: "web_search",
				grantId: "grant-1",
				organizationId: ORG_ID,
				projectId: PROJECT_ID,
			},
		);
		const logged = JSON.stringify(loggerError.mock.calls);
		expect(logged).not.toContain(aiToken);
		expect(logged).not.toContain("cloud ROI");
	});

	it("proceeds when the limiter throws, logging only the error's class", async () => {
		checkRateLimit.mockRejectedValue(new TypeError("fetch failed: redis"));

		const { status } = await call(
			readBody("https://news.example.net/report"),
			await token({ webResearchGrantId: "grant-1" }),
		);

		expect(status).toBe(200);
		expect(scrapeUrl).toHaveBeenCalledTimes(1);
		expect(loggerError).toHaveBeenCalledWith(
			"[web-research-tools] research cap unavailable",
			expect.objectContaining({
				tool: "read_url",
				grantId: "grant-1",
				errorKind: "TypeError",
			}),
		);
		expect(JSON.stringify(loggerError.mock.calls)).not.toContain(
			"fetch failed",
		);
	});

	it("spends nothing from the budget for a request it refuses earlier", async () => {
		getProjectAccessContext.mockResolvedValue(null);

		const { status } = await call(searchBody({ query: "cloud ROI" }));

		expect(status).toBe(403);
		expect(checkRateLimit).not.toHaveBeenCalled();
	});
});

describe("POST /api/internal/web-research-tools — privacy and URL policy", () => {
	it("refuses a query that names the organization, without echoing the name", async () => {
		const { status, body } = await call(
			searchBody({ query: "Example Org Holdings cloud spend" }),
		);

		expect(status).toBe(422);
		expect(body).toMatchObject({
			ok: false,
			code: "QUERY_REJECTED_CONFIDENTIAL",
			matchKind: "organization_name",
		});
		expect(JSON.stringify(body).toLowerCase()).not.toContain("example org");
		expect(search).not.toHaveBeenCalled();
	});

	it.each([
		["http://127.0.0.1/admin", "ip_literal"],
		["http://localhost:3000/", "local_host"],
	])("refuses to read %s", async (url, reason) => {
		const { status, body } = await call(readBody(url));

		expect(status).toBe(422);
		expect(body).toMatchObject({
			ok: false,
			code: "URL_NOT_ALLOWED",
			reason,
		});
		expect(scrapeUrl).not.toHaveBeenCalled();
	});

	it("refuses a URL that carries the client's name", async () => {
		const { status, body } = await call(
			readBody("https://news.example.net/companies/contoso"),
		);

		expect(status).toBe(422);
		expect(body).toMatchObject({
			code: "URL_NOT_ALLOWED",
			reason: "confidential_term",
			matchKind: "client_name",
		});
		expect(scrapeUrl).not.toHaveBeenCalled();
	});

	it.each([
		["web_search", searchBody({ query: "cloud ROI" })],
		["read_url", readBody("https://news.example.net/report")],
	])(
		"answers 500 and calls no provider for %s when the confidential terms cannot load",
		async (_tool, body) => {
			memberFindMany.mockRejectedValue(new Error("connection lost"));

			const { status, body: response } = await call(body);

			expect(status).toBe(500);
			expect(response.code).toBe("INTERNAL_ERROR");
			expect(search).not.toHaveBeenCalled();
			expect(scrapeUrl).not.toHaveBeenCalled();
		},
	);
});

describe("POST /api/internal/web-research-tools — results", () => {
	it("returns search hits without page content and counts the search", async () => {
		const { status, body } = await call(searchBody({ query: "cloud ROI" }));

		expect(status).toBe(200);
		expect(body).toEqual({
			ok: true,
			provider: "exa",
			results: [
				{
					url: "https://research.example.net/cloud-roi",
					title: "Cloud ROI study",
					snippet: "Average payback of 14 months.",
				},
			],
		});
		expect(search).toHaveBeenCalledWith("cloud ROI", 5);
		expect(incrementOrganizationSearchProviderUsage).toHaveBeenCalledWith({
			organizationId: ORG_ID,
			providerName: "exa",
			cost: 0,
		});
	});

	it.each([
		[20, 8],
		[0, 1],
		[3.7, 3],
	])("clamps maxResults %s to %s", async (requested, expected) => {
		await call(searchBody({ query: "cloud ROI", maxResults: requested }));

		expect(search).toHaveBeenCalledWith("cloud ROI", expected);
	});

	it("still answers 200 when counting the search fails", async () => {
		incrementOrganizationSearchProviderUsage.mockRejectedValue(
			new Error("row missing"),
		);

		const { status } = await call(searchBody({ query: "cloud ROI" }));

		expect(status).toBe(200);
	});

	it("returns a read page cut to 12,000 characters", async () => {
		scrapeUrl.mockResolvedValue({
			success: true,
			data: {
				pageUrl: "https://news.example.net/report",
				pageTitle: "Report",
				markdown: "x".repeat(15_000),
			},
		});

		const { status, body } = await call(
			readBody("https://news.example.net/report"),
		);

		expect(status).toBe(200);
		expect(body).toMatchObject({
			ok: true,
			url: "https://news.example.net/report",
			finalUrl: "https://news.example.net/report",
			publisher: "news.example.net",
			truncated: true,
		});
		expect(body.content).toHaveLength(12_000);
	});

	it("answers 502 SEARCH_FAILED with a safe message when the provider throws", async () => {
		search.mockRejectedValue(new Error("provider echoed cloud ROI"));

		const { status, body } = await call(searchBody({ query: "cloud ROI" }));

		expect(status).toBe(502);
		expect(body).toMatchObject({ ok: false, code: "SEARCH_FAILED" });
		expect(body.message).not.toContain("cloud ROI");
		expect(incrementOrganizationSearchProviderUsage).not.toHaveBeenCalled();
	});

	it("answers 502 FETCH_FAILED with a safe message when the reader fails", async () => {
		scrapeUrl.mockResolvedValue({
			success: false,
			error: {
				code: "UNKNOWN",
				message: "failed https://news.example.net/x",
			},
		});

		const { status, body } = await call(
			readBody("https://news.example.net/x"),
		);

		expect(status).toBe(502);
		expect(body).toMatchObject({ ok: false, code: "FETCH_FAILED" });
		expect(body.message).not.toContain("news.example.net");
	});
});

describe("POST /api/internal/web-research-tools — logs", () => {
	it("never logs the query, a URL's path or query, or page text", async () => {
		scrapeUrl.mockResolvedValue({
			success: true,
			data: {
				pageUrl:
					"https://news.example.net/deep/path-segment?token=hidden",
				pageTitle: "Report",
				markdown: "PAGE BODY TEXT",
			},
		});

		await call(searchBody({ query: "quantum widget market size" }));
		await call(
			readBody("https://news.example.net/deep/path-segment?token=hidden"),
		);
		search.mockRejectedValue(
			new Error("quantum widget market size failed"),
		);
		await call(searchBody({ query: "quantum widget market size" }));

		const logged = JSON.stringify([
			...loggerInfo.mock.calls,
			...loggerError.mock.calls,
		]);
		expect(logged).not.toContain("quantum widget");
		expect(logged).not.toContain("path-segment");
		expect(logged).not.toContain("hidden");
		expect(logged).not.toContain("PAGE BODY");
		expect(logged).toContain("news.example.net");
		expect(logged).toContain("firecrawl");
	});
});
