/** HTTP fixtures exercise the real workflow executors without contacting vendors. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeExecutionResult, StepParams } from "../../../types";
import { CONNECTOR_ACTIONS } from "./fixtures/connector-actions";

const mocks = vi.hoisted(() => ({
	credentials: vi.fn(),
	searchProvider: vi.fn(),
	fetch: vi.fn(),
	resolve: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	fetchCredentialsByProvider: mocks.credentials,
	getSearchProviderConfig: mocks.searchProvider,
}));
vi.mock("@repo/utils", () => ({ decryptApiKey: (value: string) => value }));
vi.mock("@repo/database/prisma/queries/workflows/integration-access", () => ({
	resolveWorkflowIntegrationForProvider: mocks.resolve,
	canUseWorkflowIntegrations: vi.fn(),
	workflowIntegrationAccessWhere: vi.fn(),
}));

import { fetchCredentialsByProvider as mapStoredCredentials } from "@repo/database/prisma/queries/workflows/credential-fetcher";

function storedConfig(provider: string) {
	const keys =
		CONNECTOR_ACTIONS.find((row) => row.provider === provider)
			?.credentialKeys ?? [];
	// Slack's custom OAuth settings store access_token instead of generic formFields.
	const persistedKeys = provider === "SLACK" ? ["access_token"] : keys;
	return Object.fromEntries(
		persistedKeys.map((key) => [
			key,
			key === "domain"
				? provider === "SALESFORCE"
					? "https://example.my.salesforce.com"
					: provider === "JIRA"
						? "example.atlassian.net"
						: "example.freshservice.com"
				: key.toLowerCase().includes("email") || key === "username"
					? "dev@example.com"
					: key === "teamId"
						? "example-team"
						: key === "subdomain"
							? "example"
							: provider === "SLACK"
								? "xoxb-example-test-credential"
								: "example-test-credential",
		]),
	);
}

const overrides: Record<string, Record<string, unknown>> = {
	"attio-create-record": {
		objectType: "people",
		attributes: '{"name":[{"value":"Example"}]}',
	},
	"attio-search-records": { objectType: "people" },
	"clickup-search-tasks": { listId: "example-list" },
	"stripe-get-customer": { customerId: "example-customer" },
	"stripe-create-invoice": {
		lineItems: '[{"amount":100,"quantity":1,"currency":"usd"}]',
		autoAdvance: "true",
	},
	"clerk-update-user": { firstName: "Example" },
	"github-get-diff": { prNumber: "1" },
	"blob-put": { body: "Example content" },
};
function config(row: (typeof CONNECTOR_ACTIONS)[number]) {
	return {
		...row.defaultConfig,
		...Object.fromEntries(
			row.requiredFields.map((k) => [
				k,
				k === "url"
					? "{{Input.url}}"
					: k.toLowerCase().includes("email")
						? "{{Input.email}}"
						: "{{Input.value}}",
			]),
		),
		...overrides[row.step],
	};
}
function payload(step: string): unknown {
	const responses: Record<string, unknown> = {
		"asana-create-task": { data: { gid: "example-id", name: "Example" } },
		"asana-list-tasks": {
			data: [
				{
					gid: "example-id",
					name: "Example",
					completed: false,
					due_on: null,
				},
			],
		},
		"attio-create-record": { data: { id: { record_id: "example-id" } } },
		"attio-search-records": {
			data: [
				{
					id: { record_id: "example-id" },
					values: { name: [{ value: "Example" }] },
				},
			],
		},
		"bitbucket-create-issue": {
			id: 1,
			title: "Example",
			links: { html: { href: "https://example.com/issue" } },
		},
		"bitbucket-search-issues": {
			values: [
				{
					id: 1,
					title: "Example",
					state: "new",
					links: { html: { href: "https://example.com/issue" } },
				},
			],
		},
		"blob-put": {
			url: "https://example.com/file",
			downloadUrl: "https://example.com/download",
			pathname: "example.txt",
		},
		"blob-list": {
			blobs: [
				{
					url: "https://example.com/file",
					pathname: "example.txt",
					size: 15,
					uploadedAt: "2026-01-01T00:00:00Z",
				},
			],
			hasMore: false,
			cursor: null,
		},
		"canva-list-designs": {
			items: [
				{
					id: "example-id",
					title: "Example",
					urls: {
						edit_url: "https://example.com/edit",
						view_url: "https://example.com/view",
					},
					thumbnail: { url: "https://example.com/image.png" },
				},
			],
		},
		"clickup-create-task": {
			id: "example-id",
			name: "Example",
			url: "https://example.com/task",
		},
		"clickup-search-tasks": {
			tasks: [
				{
					id: "example-id",
					name: "Example",
					title: "Example",
					url: "https://example.com/item",
					text_content: "Example",
					status: { status: "open" },
				},
			],
		},
		"fal-generate-image": {
			images: [
				{
					url: "https://example.com/image.png",
					width: 512,
					height: 512,
				},
			],
			seed: 1,
		},
		"fal-generate-video": {
			video: { url: "https://example.com/video.mp4" },
			seed: 1,
		},
		"firecrawl-search": {
			success: true,
			data: [
				{
					title: "Example",
					url: "https://example.com",
					description: "Example description",
				},
			],
		},
		"firecrawl-scrape": {
			success: true,
			data: {
				markdown: "Example content",
				metadata: {
					title: "Example",
					sourceURL: "https://example.com",
				},
			},
		},
		"freshservice-create-ticket": { ticket: { id: 1, subject: "Example" } },
		"front-create-conversation": {
			id: "example-id",
			_links: { self: "https://example.com/conversation" },
		},
		"front-list-conversations": {
			_results: [
				{
					id: "example-id",
					subject: "Example",
					status: "unassigned",
					_links: { self: "https://example.com/conversation" },
				},
			],
		},
		"github-create-issue": {
			id: 1,
			number: 1,
			html_url: "https://example.com/issue",
		},
		"github-search-issues": {
			items: [
				{
					id: 1,
					number: 1,
					title: "Example",
					html_url: "https://example.com/issue",
					state: "open",
				},
			],
			total_count: 1,
		},
		"github-get-file": {
			content: Buffer.from("Example content").toString("base64"),
			encoding: "base64",
			path: "README.md",
			sha: "example-sha",
			size: 15,
		},
		"github-get-diff": {
			title: "Example",
			state: "open",
			additions: 1,
			deletions: 0,
			changed_files: 1,
		},
		"hubspot-create-contact": { id: "example-id" },
		"hubspot-search-contacts": {
			results: [
				{
					id: "example-id",
					properties: {
						email: "dev@example.com",
						firstname: "Example",
						lastname: "User",
					},
				},
			],
		},
		"intercom-create-contact": { id: "example-id" },
		"intercom-search-conversations": {
			conversations: [{ id: "example-id", state: "open", created_at: 1 }],
		},
		"jira-create-issue": { id: "example-id", key: "EXAMPLE-1" },
		"jira-search-issues": {
			issues: [
				{
					id: "example-id",
					key: "EXAMPLE-1",
					fields: { summary: "Example", status: { name: "Open" } },
				},
			],
		},
		"linear-create-ticket": {
			data: {
				issueCreate: {
					success: true,
					issue: {
						id: "example-id",
						identifier: "EXAMPLE-1",
						title: "Example",
						url: "https://example.com/issue",
					},
				},
			},
		},
		"linear-find-issues": {
			data: {
				issues: {
					nodes: [
						{
							id: "example-id",
							identifier: "EXAMPLE-1",
							title: "Example",
							url: "https://example.com/issue",
							state: { name: "Open" },
							assignee: {
								name: "Example",
								email: "dev@example.com",
							},
						},
					],
				},
			},
		},
		"perplexity-search": {
			choices: [{ message: { content: "Example answer" } }],
			citations: [],
			model: "example-model",
		},
		"email-send": { id: "example-id" },
		"salesforce-create-lead": { id: "example-id", success: true },
		"salesforce-query-records": {
			records: [{ Id: "example-id", Name: "Example" }],
			totalSize: 1,
		},
		"slack-send": { ok: true, ts: "1.0", channel: "example-channel" },
		"zendesk-create-ticket": {
			ticket: {
				id: 1,
				url: "https://example.com/ticket",
				subject: "Example",
			},
		},
		"zendesk-search-tickets": {
			results: [
				{
					id: 1,
					url: "https://example.com/ticket",
					subject: "Example",
					status: "open",
					priority: "normal",
					result_type: "ticket",
				},
			],
		},
		"clerk-get-user": {
			id: "example-id",
			first_name: "Example",
			last_name: "User",
			primary_email_address_id: "example-email",
			email_addresses: [
				{ id: "example-email", email_address: "dev@example.com" },
			],
		},
		"clerk-create-user": {
			id: "example-id",
			first_name: "Example",
			last_name: "User",
			primary_email_address_id: "example-email",
			email_addresses: [
				{ id: "example-email", email_address: "dev@example.com" },
			],
		},
		"clerk-update-user": {
			id: "example-id",
			first_name: "Example",
			last_name: "User",
			primary_email_address_id: "example-email",
			email_addresses: [
				{ id: "example-email", email_address: "dev@example.com" },
			],
		},
		"clerk-delete-user": {
			id: "example-id",
			object: "user",
			deleted: true,
		},
		"stripe-create-customer": {
			id: "example-id",
			email: "dev@example.com",
			name: "Example",
			created: 1,
		},
		"stripe-get-customer": {
			id: "example-id",
			email: "dev@example.com",
			name: "Example",
			created: 1,
		},
		"stripe-create-invoice": {
			id: "example-id",
			number: "EXAMPLE-1",
			hosted_invoice_url: "https://example.com/invoice",
			status: "open",
		},
		"superagent-guard": {
			classification: "safe",
			violation_types: [],
			cwe_codes: [],
			reasoning: "Example",
		},
		"superagent-redact": { redacted_text: "Example", reasoning: "Example" },
		"webflow-list-sites": {
			sites: [
				{
					id: "example-id",
					displayName: "Example site",
					shortName: "example-site",
				},
			],
		},
		"webflow-get-site": {
			id: "example-id",
			displayName: "Example site",
			shortName: "example-site",
			previewUrl: "https://example.com/preview",
			lastPublished: "2026-01-01T00:00:00Z",
			customDomains: [],
		},
		"webflow-publish-site": {
			customDomains: [{ url: "https://example.com" }],
			publishToWebflowSubdomain: true,
		},
	};
	if (!(step in responses)) {
		throw new Error(`No HTTP response fixture for ${step}`);
	}
	return responses[step];
}

let currentStep = "";
beforeEach(() => {
	vi.clearAllMocks();
	mocks.resolve.mockImplementation(async (provider) => ({
		provider,
		credentials: JSON.stringify(storedConfig(provider)),
	}));
	mocks.credentials.mockImplementation(mapStoredCredentials);
	mocks.searchProvider.mockResolvedValue({
		encryptedApiKey: "example-encrypted",
	});
	mocks.fetch.mockImplementation(
		async (_url, init) =>
			new Response(
				currentStep === "github-get-diff" &&
					init?.headers?.Accept === "application/vnd.github.v3.diff"
					? "diff --git a/example b/example"
					: JSON.stringify(payload(currentStep)),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			),
	);
	vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => vi.unstubAllGlobals());
async function execute(
	row: (typeof CONNECTOR_ACTIONS)[number],
	overrides: Record<string, unknown> = {},
) {
	currentStep = row.step;
	const module = await import(`../${row.step}.ts`);
	const fn = module[row.fn] as (
		params: StepParams,
	) => Promise<NodeExecutionResult>;
	return fn({
		nodeConfig: { ...config(row), ...overrides },
		inputs: {
			Input: {
				value: "Example",
				url: "https://example.com",
				email: "dev@example.com",
			},
		},
		userId: "example-user",
		organizationId: "example-org",
	});
}
const excluded = new Set([
	"ai-generate-text",
	"ai-generate-image",
	"databricks-sql-query",
	"databricks-sql-ai-query",
	"gitlab-create-issue",
	"gitlab-search-issues",
	"gitlab-get-file",
	"mcp-tool",
	"mcp-review-ado-stories",
]);
it("covers every bound REST connector action in the workflow palette", () => {
	const root = join(
		process.cwd(),
		"../../apps/web/modules/saas/workflows/lib/plugins",
	);
	const steps = readdirSync(root, { withFileTypes: true })
		.filter((d) => d.isDirectory() && d.name !== "__tests__")
		.flatMap((d) => {
			try {
				return [
					...readFileSync(
						join(root, d.name, "index.ts"),
						"utf8",
					).matchAll(/stepImportPath:\s*"([^"]+)"/g),
				].map((m) => m[1]);
			} catch {
				return [];
			}
		})
		.filter((s) => !excluded.has(s));
	expect(CONNECTOR_ACTIONS.map((r) => r.step).sort()).toEqual(steps.sort());
});
describe.each(CONNECTOR_ACTIONS)("$provider/$step", (row) => {
	it("executes against an HTTP fixture and supplies every advertised output", async () => {
		const result = await execute(row);
		expect(result.success, result.error).toBe(true);
		expect(mocks.fetch).toHaveBeenCalled();
		const body = [
			"firecrawl-scrape",
			"firecrawl-search",
			"fal-generate-image",
		].includes(row.step)
			? JSON.parse(mocks.fetch.mock.calls[0][1]?.body ?? "{}")
			: {};
		if (row.step === "firecrawl-scrape") {
			expect(body.formats).toEqual(["markdown"]);
		}
		if (row.step === "firecrawl-search") {
			expect(typeof body.limit).toBe("number");
		}
		if (row.step === "fal-generate-image") {
			expect(typeof body.num_inference_steps).toBe("number");
			expect(typeof body.guidance_scale).toBe("number");
		}

		for (const [url, init] of mocks.fetch.mock.calls) {
			const headers = new Headers(init?.headers);
			expect(
				headers.get("Authorization") ||
					headers.get("X-API-Key") ||
					headers.get("Api-Key"),
				"request authentication",
			).toBeTruthy();
			let auth =
				headers.get("Authorization") ||
				headers.get("X-API-Key") ||
				headers.get("Api-Key") ||
				"";
			if (auth.startsWith("Basic ")) {
				auth = Buffer.from(auth.slice(6), "base64").toString("utf8");
			}
			const mapped =
				row.provider === "FIRECRAWL"
					? { key: "example-encrypted" }
					: await mocks.credentials.mock.results[0].value;
			const expectedKey = Object.entries(mapped).find(
				([key]) =>
					row.provider === "FIRECRAWL" ||
					/(TOKEN|KEY|SECRET)$/.test(key),
			)?.[1];
			expect(expectedKey, "mapped credential").toBeTruthy();
			expect(auth).toContain(expectedKey);

			expect(
				JSON.stringify({ url, body: init?.body }),
				"no unresolved workflow input",
			).not.toMatch(/\{\{|%7b%7b/i);
		}

		if (
			[
				"asana-list-tasks",
				"attio-search-records",
				"bitbucket-search-issues",
				"blob-list",
				"canva-list-designs",
				"clickup-search-tasks",
				"firecrawl-search",
				"front-list-conversations",
				"github-search-issues",
				"hubspot-search-contacts",
				"intercom-search-conversations",
				"jira-search-issues",
				"linear-find-issues",
				"salesforce-query-records",
				"zendesk-search-tickets",
				"webflow-list-sites",
			].includes(row.step)
		) {
			for (const value of Object.values(result.output ?? {})) {
				if (Array.isArray(value)) {
					expect(value).toHaveLength(1);
				}
			}
			if ("count" in (result.output ?? {})) {
				expect(result.output?.count).toBe(1);
			}
		}
		for (const field of row.outputFields) {
			expect(
				result.output?.[field],
				`advertised ${field}`,
			).not.toBeUndefined();
		}
		if (row.step === "webflow-publish-site") {
			expect(result.output?.publishedDomains).toEqual([
				"https://example.com",
			]);
		}
		if (row.provider === "FIRECRAWL") {
			expect(mocks.searchProvider).toHaveBeenCalledWith({
				userId: "example-user",
				organizationId: "example-org",
				providerName: "firecrawl",
			});
		} else {
			expect(mocks.credentials).toHaveBeenCalledWith(
				row.provider,
				"example-user",
				"example-org",
			);
		}
	});
	it("refuses missing credentials before any HTTP request", async () => {
		mocks.credentials.mockResolvedValue(null);
		mocks.searchProvider.mockResolvedValue(null);
		const result = await execute(row);
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
		expect(mocks.fetch).not.toHaveBeenCalled();
	});
	it("refuses an empty persisted credential object before HTTP", async () => {
		mocks.resolve.mockResolvedValue({
			provider: row.provider,
			credentials: "{}",
		});
		mocks.searchProvider.mockResolvedValue(null);
		const result = await execute(row);
		expect(result.success).toBe(false);
		expect(mocks.fetch).not.toHaveBeenCalled();
	});

	it.each([401, 429, 500])(
		"propagates HTTP %s as failure",
		async (status) => {
			mocks.fetch.mockImplementation(
				async () =>
					new Response(
						JSON.stringify({ message: "Example HTTP failure" }),
						{
							status,
							headers: { "content-type": "application/json" },
						},
					),
			);
			const result = await execute(row);
			expect(result.success).toBe(false);
			expect(typeof result.error).toBe("string");
			expect(result.error).toBeTruthy();
		},
	);
	it("normalizes a nested provider error to a string", async () => {
		mocks.fetch.mockImplementation(
			async () =>
				new Response(
					JSON.stringify({
						ok: false,
						success: false,
						error: { message: "Example nested error" },
					}),
					{
						status: 500,
						headers: { "content-type": "application/json" },
					},
				),
		);
		const result = await execute(row);
		expect(result.success).toBe(false);
		expect(typeof result.error).toBe("string");
		expect(result.error).toBeTruthy();
	});
	if (row.provider === "FIRECRAWL") {
		it("uses a workflow-only Firecrawl connection when no search-provider key exists", async () => {
			mocks.searchProvider.mockResolvedValue(null);
			const result = await execute(row);
			expect(result.success, result.error).toBe(true);
			expect(mocks.credentials).toHaveBeenCalledWith(
				"FIRECRAWL",
				"example-user",
				"example-org",
			);
		});
	}

	if (row.step === "blob-put") {
		it.each([
			"\\example.org/collect",
			"/\\example.org/collect",
			"folder/file?addRandomSuffix=true#fragment",
		])("keeps upload path %s on the Blob origin", async (pathname) => {
			const result = await execute(row, {
				pathname,
				addRandomSuffix: "false",
			});
			expect(result.success, result.error).toBe(true);
			const [url, init] = mocks.fetch.mock.calls[0];
			const target = new URL(url);
			expect(target.origin).toBe("https://blob.vercel-storage.com");
			expect(target.searchParams.get("addRandomSuffix")).toBe("false");
			expect(target.hash).toBe("");
			expect(decodeURIComponent(target.pathname)).toBe(
				`/${pathname.replace(/^\/+/, "")}`,
			);
			expect(init.redirect).toBe("error");
		});
	}

	it("reports network failure without a successful output", async () => {
		mocks.fetch.mockRejectedValue(new Error("Example network failure"));
		const result = await execute(row);
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});
});

describe.each([
	["BLOB", "BLOB_READ_WRITE_TOKEN"],
	["CLERK", "CLERK_SECRET_KEY"],
	["STRIPE", "STRIPE_SECRET_KEY"],
	["SUPERAGENT", "SUPERAGENT_API_KEY"],
	["WEBFLOW", "WEBFLOW_API_KEY"],
] as const)("%s persisted key compatibility", (provider, key) => {
	it("maps legacy API credential rows", async () => {
		mocks.resolve.mockResolvedValue({
			provider,
			credentials: JSON.stringify({ [key]: "example-legacy-key" }),
		});
		expect(
			await mapStoredCredentials(provider, "example-user", "example-org"),
		).toEqual({ [key]: "example-legacy-key" });
	});
	it("prefers the canonical UI key if both shapes are present", async () => {
		mocks.resolve.mockResolvedValue({
			provider,
			credentials: JSON.stringify({
				apiKey: "example-ui-key",
				[key]: "example-legacy-key",
			}),
		});
		expect(
			await mapStoredCredentials(provider, "example-user", "example-org"),
		).toEqual({ [key]: "example-ui-key" });
	});
});
