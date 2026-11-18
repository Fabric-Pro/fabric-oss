import { createRequire } from "node:module";
import {
	createSafeOutboundLookup,
	type safeFetchOutboundPinned,
} from "@repo/utils/url-security";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeFreshserviceCreateTicketStep } from "../freshservice-create-ticket";
import { executeHybridStep } from "../hybrid-step";
import { executeJiraCreateIssueStep } from "../jira-create-issue";
import { executeJiraSearchIssuesStep } from "../jira-search-issues";
import { executeSalesforceCreateLeadStep } from "../salesforce-create-lead";
import { executeSalesforceQueryRecordsStep } from "../salesforce-query-records";

import { executeZendeskCreateTicketStep } from "../zendesk-create-ticket";

import { executeZendeskSearchTicketsStep } from "../zendesk-search-tickets";

const { credentials, pinnedFetch } = vi.hoisted(() => ({
	credentials: vi.fn(),
	pinnedFetch: vi.fn<typeof safeFetchOutboundPinned>(),
}));
vi.mock("@repo/utils/url-security", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@repo/utils/url-security")>();
	return {
		...actual,
		safeFetchOutboundPinned: pinnedFetch.mockImplementation(
			actual.safeFetchOutboundPinned,
		),
	};
});
vi.mock("@repo/database", () => ({
	fetchCredentialsByProvider: credentials,
}));
vi.mock("../../../browser-automation", () => ({
	closeBrowserSession: vi.fn(),
	createBrowserSession: vi.fn(),
	executeAction: vi.fn(),
	extractContent: vi.fn(),
	navigateToUrl: vi.fn(),
}));

const params = {
	inputs: {},
	userId: "example-user",
	organizationId: "example-org",
};
const loopback = "https://127.0.0.1/";

function hybrid(url: string, timeout?: number) {
	return executeHybridStep({
		...params,
		nodeConfig: { mode: "api-only", api: { url, timeout } },
	});
}

function salesforce(domain: string) {
	credentials.mockResolvedValue({
		SALESFORCE_DOMAIN: domain,
		SALESFORCE_ACCESS_TOKEN: "example-token",
	});
	return executeSalesforceQueryRecordsStep({
		...params,
		nodeConfig: { query: "SELECT Id FROM Lead" },
	});
}

afterEach(() => vi.unstubAllGlobals());

describe.each([
	{ name: "hybrid API", execute: hybrid },
	{ name: "Salesforce query", execute: salesforce },
])("$name", ({ execute }) => {
	it("refuses loopback before reaching the HTTP transport", async () => {
		const transport = vi.fn();
		vi.stubGlobal("fetch", transport);

		expect(await execute(loopback)).toMatchObject({
			success: false,
			error: expect.stringMatching(/destination is not allowed/i),
		});
		expect(transport).not.toHaveBeenCalled();
	});
});

it("refuses a hybrid redirect to loopback", async () => {
	const redirect = Response.redirect(loopback, 302);
	const redirectedRequest = vi.fn(() => Response.json({}));
	const transport = vi.fn(async (_url: string, init?: RequestInit) => {
		switch (init?.redirect) {
			case "error":
				throw new TypeError("fetch failed");
			case "manual":
				return redirect;
			default:
				return redirectedRequest();
		}
	});
	vi.stubGlobal("fetch", transport);

	expect(await hybrid("https://example.com")).toMatchObject({
		success: false,
		error: "Request failed: the server responded with a redirect, and redirects are not followed.",
	});
	expect(transport).toHaveBeenCalledTimes(1);
	expect(redirectedRequest).not.toHaveBeenCalled();
});

it("reports the hybrid timeout as an abort", async () => {
	const reason = new DOMException("The operation was aborted", "AbortError");
	vi.stubGlobal(
		"fetch",
		vi.fn(
			(_url, init: RequestInit) =>
				new Promise((_resolve, reject) =>
					init.signal?.addEventListener(
						"abort",
						() => reject(reason),
						{ once: true },
					),
				),
		),
	);

	expect(await hybrid("https://example.com", 1)).toMatchObject({
		success: false,
		error: reason.message,
	});
});

it("reports the original message for a hybrid connection failure", async () => {
	const error = new TypeError("Example connection failed", {
		cause: Object.assign(new Error("Example connection denied"), {
			code: "EACCES",
		}),
	});
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));

	expect(await hybrid("https://example.com")).toMatchObject({
		success: false,
		error: error.message,
	});
});

it("reports a DNS address refusal without exposing the lookup detail", async () => {
	const lookup = createSafeOutboundLookup((_host, _options, callback) => {
		callback(null, [{ address: "127.0.0.1", family: 4 }]);
	});
	const cause = await new Promise<Error | null>((resolve) => {
		lookup("example.com", {}, (error) => resolve(error));
	});
	expect(cause).toMatchObject({ code: "EACCES" });
	vi.stubGlobal(
		"fetch",
		vi.fn().mockRejectedValue(new TypeError("fetch failed", { cause })),
	);

	expect(await hybrid("https://example.com")).toMatchObject({
		success: false,
		error: "Request blocked: destination is not allowed.",
	});
});

it("refuses a stored HTTP domain before reaching the HTTP transport", async () => {
	const transport = vi.fn();
	vi.stubGlobal("fetch", transport);

	expect(await salesforce("http://example.com")).toMatchObject({
		success: false,
		error: expect.stringMatching(/destination is not allowed.*https/i),
	});
	expect(transport).not.toHaveBeenCalled();
});

it.each([
	{
		step: "Jira create issue",
		execute: executeJiraCreateIssueStep,
		nodeConfig: { projectKey: "EXAMPLE", summary: "Example issue" },
		storedCredentials: {
			JIRA_DOMAIN: "http://example.com/",
			JIRA_EMAIL: "dev@example.com",
			JIRA_API_TOKEN: "example-token",
		},
		expectedUrl: "https://example.com/rest/api/3/issue",
		response: { key: "EXAMPLE-1" },
	},
	{
		step: "Jira search issues",
		execute: executeJiraSearchIssuesStep,
		nodeConfig: { jql: "project = EXAMPLE" },
		storedCredentials: {
			JIRA_DOMAIN: "http://example.com/context/",
			JIRA_EMAIL: "dev@example.com",
			JIRA_API_TOKEN: "example-token",
		},
		expectedUrl: "https://example.com/context/rest/api/3/search/jql",
		response: { issues: [] },
	},
	{
		step: "Freshservice create ticket",
		execute: executeFreshserviceCreateTicketStep,
		nodeConfig: { subject: "Example ticket" },
		storedCredentials: {
			FRESHSERVICE_DOMAIN: "http://example.com/context/",
			FRESHSERVICE_API_KEY: "example-token",
		},
		expectedUrl: "https://example.com/context/api/v2/tickets",
		response: { ticket: { id: 1 } },
	},
])(
	"$step keeps using HTTPS for an HTTP-prefixed stored domain",
	async ({
		execute,
		nodeConfig,
		storedCredentials,
		expectedUrl,
		response,
	}) => {
		credentials.mockResolvedValue(storedCredentials);
		const transport = vi.fn(async () => Response.json(response));
		vi.stubGlobal("fetch", transport);

		expect(await execute({ ...params, nodeConfig })).toMatchObject({
			success: true,
		});
		expect(transport).toHaveBeenCalledExactlyOnceWith(
			expectedUrl,
			expect.objectContaining({
				dispatcher: expect.anything(),
				redirect: "manual",
			}),
		);
	},
);

function lead(domain: string) {
	credentials.mockResolvedValue({
		SALESFORCE_DOMAIN: domain,
		SALESFORCE_ACCESS_TOKEN: "example-token",
	});
	return executeSalesforceCreateLeadStep({
		...params,
		nodeConfig: { lastName: "Example", company: "Example" },
	});
}

const zendeskCredentials = {
	ZENDESK_SUBDOMAIN: "example",
	ZENDESK_EMAIL: "dev@example.com",
	ZENDESK_TOKEN: "example-token",
};

it("refuses a stored HTTP domain for Salesforce lead creation", async () => {
	const transport = vi.fn();
	vi.stubGlobal("fetch", transport);

	expect(await lead("http://example.com")).toMatchObject({
		success: false,
		error: expect.stringMatching(/destination is not allowed.*https/i),
	});
	expect(transport).not.toHaveBeenCalled();
});

it.each([
	{
		step: "Salesforce create lead",
		execute: () => lead("example.com"),
		url: "https://example.com/services/data/v61.0/sobjects/Lead",
		output: { id: "example-id", success: true },
	},
	{
		step: "Zendesk create ticket",
		execute: () => {
			credentials.mockResolvedValue(zendeskCredentials);
			return executeZendeskCreateTicketStep({
				...params,
				nodeConfig: {
					subject: "Example",
					description: "Example ticket",
				},
			});
		},
		url: "https://example.zendesk.com/api/v2/tickets.json",
		output: { ticket: { id: 1 } },
	},
])(
	"$step sends requests through the checked dispatcher",
	async ({ execute, url, output }) => {
		const transport = vi.fn(async () => Response.json(output));
		vi.stubGlobal("fetch", transport);

		expect(await execute()).toMatchObject({ success: true });
		expect(transport).toHaveBeenCalledExactlyOnceWith(
			url,
			expect.objectContaining({
				dispatcher: expect.anything(),
				redirect: "manual",
			}),
		);
	},
);

function zendeskSearch() {
	credentials.mockResolvedValue(zendeskCredentials);
	return executeZendeskSearchTicketsStep({
		...params,
		nodeConfig: { query: "example" },
	});
}

describe("provider GET redirects", () => {
	// The HTTP transport fixture disables network access. The real pinned guard
	// still resolves both hosts through the fixture resolver.
	const require = createRequire(
		import.meta.resolve("@repo/utils/url-security"),
	);
	const { MockAgent } = require("undici");
	let agent: InstanceType<typeof MockAgent>;
	const lookup = vi.fn(async (_host: string) => [
		{ address: "93.184.216.34", family: 4 },
	]);

	beforeEach(async () => {
		agent = new MockAgent();
		agent.disableNetConnect();
		lookup.mockClear();
		pinnedFetch.mockClear();
		const actual = await vi.importActual<
			typeof import("@repo/utils/url-security")
		>("@repo/utils/url-security");
		pinnedFetch.mockImplementation((input, init, options) =>
			actual.safeFetchOutboundPinned(input, init, {
				...options,
				dispatcher: agent,
				lookup,
			}),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Response.json({ results: [], records: [] })),
		);
	});
	afterEach(async () => {
		await agent.close();
	});

	it("Zendesk search follows a public HTTPS redirect without forwarding Authorization", async () => {
		agent
			.get("https://example.zendesk.com")
			.intercept({
				path: "/api/v2/search.json?query=example",
				headers: { authorization: /^Basic / },
			})
			.reply(302, "", {
				headers: { location: "https://example.com/results" },
			});
		const receivedHeaders = vi.fn();
		agent
			.get("https://example.com")
			.intercept({ path: "/results" })
			.reply((request: { headers: HeadersInit }) => {
				receivedHeaders(
					new Headers(request.headers).get("authorization"),
				);
				return { statusCode: 200, data: { results: [] } };
			});

		expect(await zendeskSearch()).toMatchObject({ success: true });
		expect(lookup.mock.calls).toEqual([
			["example.zendesk.com"],
			["example.com"],
		]);
		expect(receivedHeaders).toHaveBeenCalledExactlyOnceWith(null);
		expect(fetch).not.toHaveBeenCalled();
		agent.assertNoPendingInterceptors();
	});

	it("passes a 120-second timeout with one deadline across provider GET redirects", async () => {
		pinnedFetch
			.mockResolvedValueOnce(
				Response.redirect("https://example.com/results", 302),
			)
			.mockResolvedValueOnce(Response.json({ results: [] }));

		expect(await zendeskSearch()).toMatchObject({ success: true });
		expect(pinnedFetch).toHaveBeenCalledTimes(2);
		const [first, second] = pinnedFetch.mock.calls;
		expect(first?.[2]).toMatchObject({ timeoutMs: 120_000 });
		expect(second?.[2]).toMatchObject({ timeoutMs: 120_000 });
		expect(first?.[1]?.signal).toBeInstanceOf(AbortSignal);
		expect(second?.[1]?.signal).toBe(first?.[1]?.signal);
	});

	it.each([
		["loopback", loopback],
		["HTTP", "http://example.com/results"],
	])("Salesforce query refuses a redirect to %s", async (_kind, location) => {
		agent
			.get("https://example.com")
			.intercept({
				path: "/services/data/v61.0/query?q=SELECT%20Id%20FROM%20Lead",
			})
			.reply(302, "", { headers: { location } });

		expect(await salesforce("example.com")).toMatchObject({
			success: false,
			error: expect.stringMatching(/destination is not allowed/i),
		});
		expect(lookup.mock.calls).toEqual([["example.com"]]);
		expect(fetch).not.toHaveBeenCalled();
		agent.assertNoPendingInterceptors();
	});

	it("refuses a provider redirect with no Location header", async () => {
		agent
			.get("https://example.zendesk.com")
			.intercept({
				path: "/api/v2/search.json?query=example",
			})
			.reply(302);
		expect(await zendeskSearch()).toMatchObject({
			success: false,
			error: "Request failed: the server responded with a redirect without a Location header.",
		});
		agent.assertNoPendingInterceptors();
	});

	it("refuses a provider redirect beyond the hop limit", async () => {
		agent
			.get("https://example.zendesk.com")
			.intercept({
				path: "/api/v2/search.json?query=example",
			})
			.reply(302, "", { headers: { location: "/redirect" } });
		const redirects = agent.get("https://example.zendesk.com");
		redirects
			.intercept({ path: "/redirect" })
			.reply(302, "", { headers: { location: "/redirect" } })
			.times(3);
		expect(await zendeskSearch()).toMatchObject({
			success: false,
			error: "Request failed: the server returned too many redirects.",
		});
		expect(lookup).toHaveBeenCalledTimes(4);
		agent.assertNoPendingInterceptors();
	});

	it("reports the original DNS failure for a provider GET", async () => {
		lookup.mockRejectedValueOnce(
			Object.assign(new Error("Example DNS lookup failed"), {
				code: "ENOTFOUND",
			}),
		);

		expect(await zendeskSearch()).toMatchObject({
			success: false,
			error: "Example DNS lookup failed",
		});
	});
});
