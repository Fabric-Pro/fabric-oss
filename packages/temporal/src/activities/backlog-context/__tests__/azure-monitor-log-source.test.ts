/**
 * Unit tests for the Azure Monitor log-source adapter (Fizzy #1234).
 *
 * Three things matter here and none needs a workspace:
 *   1. The KQL is injection-safe. The search terms come from a user-supplied
 *      analysis prompt, so they are untrusted input landing in a query
 *      language.
 *   2. The native `{tables:[{columns, rows}]}` envelope converts correctly.
 *      Log Analytics returns rows as positional ARRAYS with a separate column
 *      list, which nothing else in this feature speaks.
 *   3. The bounds reach the query rather than being trimmed afterwards.
 */

import type { LogQueryScope } from "@repo/ai/lib/log-context";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	azureMonitorProvider,
	buildLogQuery,
	configuredManagedIdentityClientId,
	createAzureMonitorLogSourceAdapter,
	kqlStringLiteral,
	parseLogAnalyticsResponse,
} from "../azure-monitor-log-source";

const SCOPE: LogQueryScope = {
	lookbackMinutes: 1440,
	minSeverity: "error",
	maxEntries: 50,
	terms: ["checkout", "timeout"],
};

describe("kqlStringLiteral — injection guard", () => {
	it("escapes a double quote so the literal cannot be closed early", () => {
		// Without escaping this would terminate the string and append a clause.
		const out = kqlStringLiteral('a" | project secret=1 //');
		expect(out.startsWith('"')).toBe(true);
		expect(out.endsWith('"')).toBe(true);
		// Exactly two unescaped quotes: the delimiters.
		expect(out.replace(/\\"/g, "").match(/"/g)).toHaveLength(2);
	});

	it("escapes backslashes so an escape cannot be smuggled in", () => {
		expect(kqlStringLiteral("a\\b")).toBe('"a\\\\b"');
	});

	it("strips control characters", () => {
		const out = kqlStringLiteral("a\nb\tc");
		expect(out).not.toContain("\n");
		expect(out).not.toContain("\t");
	});

	it("caps an over-long term", () => {
		expect(kqlStringLiteral("x".repeat(500)).length).toBeLessThan(200);
	});
});

describe("buildLogQuery", () => {
	it("carries every bound into the query", () => {
		const q = buildLogQuery(SCOPE);
		expect(q).toContain("ago(1440m)");
		expect(q).toContain("take 50");
		// error -> Application Insights severity 3
		expect(q).toContain("_sev >= 3");
		expect(q).toContain('has_any ("checkout", "timeout")');
	});

	it("maps the severity floor to Application Insights levels", () => {
		expect(buildLogQuery({ ...SCOPE, minSeverity: "info" })).toContain(
			"_sev >= 1",
		);
		expect(buildLogQuery({ ...SCOPE, minSeverity: "warning" })).toContain(
			"_sev >= 2",
		);
	});

	it("omits the term filter when there are no terms", () => {
		expect(buildLogQuery({ ...SCOPE, terms: [] })).not.toContain("has_any");
	});

	it("bounds a hostile lookback and limit rather than trusting them", () => {
		const q = buildLogQuery({
			...SCOPE,
			lookbackMinutes: -5,
			maxEntries: 0,
		});
		expect(q).toContain("ago(1m)");
		expect(q).toContain("take 1");
	});
});

describe("tenant scoping — shared vs dedicated workspaces", () => {
	it("a shared-store query carries the organization predicate", () => {
		const q = buildLogQuery(
			{ ...SCOPE, organizationId: "org-123" },
			{ requireTenantPredicate: true },
		);
		expect(q).toContain(
			'| where tostring(Properties["organizationId"]) == "org-123"',
		);
	});

	it("a dedicated-store query carries no organization predicate", () => {
		const q = buildLogQuery({ ...SCOPE, organizationId: "org-123" });
		expect(q).not.toContain("organizationId");
	});

	it("a shared-store query without an organization id fails closed", () => {
		expect(() =>
			buildLogQuery(SCOPE, { requireTenantPredicate: true }),
		).toThrow(/organization id/);
	});

	it("the predicate precedes the term filter so the platform narrows early", () => {
		const q = buildLogQuery(
			{ ...SCOPE, organizationId: "org-1" },
			{ requireTenantPredicate: true },
		);
		const predicate = q.indexOf('tostring(Properties["organizationId"])');
		const terms = q.indexOf("has_any");
		expect(predicate).toBeGreaterThan(-1);
		expect(terms).toBeGreaterThan(predicate);
	});

	it("escapes the organization id like any other literal", () => {
		const q = buildLogQuery(
			{ ...SCOPE, organizationId: 'org"x' },
			{ requireTenantPredicate: true },
		);
		expect(q).toContain('== "org\\"x"');
	});

	it("marks the deployment source shared and a project binding dedicated", () => {
		const ORIGINAL = process.env.FABRIC_BUG_ANALYSIS_LOG_WORKSPACE_ID;
		const ORIGINAL_OPT_IN =
			process.env.FABRIC_BUG_ANALYSIS_LOG_ALLOW_SHARED_WORKSPACE;
		try {
			process.env.FABRIC_BUG_ANALYSIS_LOG_WORKSPACE_ID = "ws-env";
			process.env.FABRIC_BUG_ANALYSIS_LOG_ALLOW_SHARED_WORKSPACE = "true";
			expect(azureMonitorProvider.fromEnvironment()?.sharedStore).toBe(
				true,
			);
			expect(
				azureMonitorProvider.fromProjectConfig({
					workspaceId: "ws-project",
				})?.sharedStore,
			).toBe(false);
		} finally {
			process.env.FABRIC_BUG_ANALYSIS_LOG_WORKSPACE_ID = ORIGINAL;
			process.env.FABRIC_BUG_ANALYSIS_LOG_ALLOW_SHARED_WORKSPACE =
				ORIGINAL_OPT_IN;
		}
	});

	it("does not serve the deployment workspace without the operator opt-in", () => {
		// The security review held a shared platform workspace shouldn't be a
		// customer-facing source: scoping alone would make it live the moment
		// telemetry starts tagging org ids, so serving it is opt-in.
		const ORIGINAL = process.env.FABRIC_BUG_ANALYSIS_LOG_WORKSPACE_ID;
		const ORIGINAL_OPT_IN =
			process.env.FABRIC_BUG_ANALYSIS_LOG_ALLOW_SHARED_WORKSPACE;
		try {
			process.env.FABRIC_BUG_ANALYSIS_LOG_WORKSPACE_ID = "ws-env";
			delete process.env.FABRIC_BUG_ANALYSIS_LOG_ALLOW_SHARED_WORKSPACE;
			expect(azureMonitorProvider.fromEnvironment()).toBeNull();
			process.env.FABRIC_BUG_ANALYSIS_LOG_ALLOW_SHARED_WORKSPACE =
				"false";
			expect(azureMonitorProvider.fromEnvironment()).toBeNull();
		} finally {
			process.env.FABRIC_BUG_ANALYSIS_LOG_WORKSPACE_ID = ORIGINAL;
			process.env.FABRIC_BUG_ANALYSIS_LOG_ALLOW_SHARED_WORKSPACE =
				ORIGINAL_OPT_IN;
		}
	});

	it("refuses a project binding that names the deployment's shared workspace", () => {
		const ORIGINAL = process.env.FABRIC_BUG_ANALYSIS_LOG_WORKSPACE_ID;
		try {
			process.env.FABRIC_BUG_ANALYSIS_LOG_WORKSPACE_ID = "ws-shared";
			// The worker identity holds read on that workspace; honouring the
			// binding would hand a project admin the very cross-tenant reads
			// the shared-store predicate exists to prevent. Workspace ids are
			// GUIDs, so a re-cased spelling names the SAME workspace and must
			// be caught too.
			expect(
				azureMonitorProvider.fromProjectConfig({
					workspaceId: " ws-shared ",
				}),
			).toBeNull();
			expect(
				azureMonitorProvider.fromProjectConfig({
					workspaceId: "WS-Shared",
				}),
			).toBeNull();
			// A different workspace is still accepted.
			expect(
				azureMonitorProvider.fromProjectConfig({
					workspaceId: "ws-their-own",
				}),
			).not.toBeNull();
		} finally {
			process.env.FABRIC_BUG_ANALYSIS_LOG_WORKSPACE_ID = ORIGINAL;
		}
	});
});

describe("parseLogAnalyticsResponse", () => {
	const envelope = {
		tables: [
			{
				name: "PrimaryResult",
				columns: [
					{ name: "TimeGenerated" },
					{ name: "SeverityLevel" },
					{ name: "Message" },
					{ name: "Properties" },
				],
				rows: [
					[
						"2026-08-19T10:00:00Z",
						3,
						"checkout failed",
						'{"requestId":"req-1"}',
					],
				],
			},
		],
	};

	it("converts the columns/rows envelope into entries", () => {
		const parsed = parseLogAnalyticsResponse(envelope);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]).toEqual({
			message: "checkout failed",
			timestamp: "2026-08-19T10:00:00Z",
			// Azure sends a number; the port speaks strings.
			severity: "3",
			properties: { requestId: "req-1" },
		});
	});

	it("skips rows with no usable message rather than emitting blanks", () => {
		const parsed = parseLogAnalyticsResponse({
			tables: [
				{
					columns: [{ name: "Message" }],
					rows: [[""], [null], ["  "], ["real"]],
				},
			],
		});
		expect(parsed).toHaveLength(1);
		expect(parsed[0]?.message).toBe("real");
	});

	it("drops a Properties value that is not JSON rather than guessing", () => {
		const parsed = parseLogAnalyticsResponse({
			tables: [
				{
					columns: [{ name: "Message" }, { name: "Properties" }],
					rows: [["m", "not json at all"]],
				},
			],
		});
		expect(parsed[0]?.properties).toBeUndefined();
	});

	it("returns nothing for shapes it does not recognise", () => {
		expect(parseLogAnalyticsResponse(null)).toEqual([]);
		expect(parseLogAnalyticsResponse({})).toEqual([]);
		expect(parseLogAnalyticsResponse({ tables: [] })).toEqual([]);
		expect(
			parseLogAnalyticsResponse({ tables: [{ rows: "nope" }] }),
		).toEqual([]);
	});
});

describe("createAzureMonitorLogSourceAdapter", () => {
	function adapterWith(response: unknown, ok = true) {
		const fetchImpl = vi.fn().mockResolvedValue({
			ok,
			status: ok ? 200 : 403,
			json: async () => response,
		}) as unknown as typeof fetch;
		const adapter = createAzureMonitorLogSourceAdapter({
			workspaceId: "ws-1",
			sharedStore: false,
			getToken: async () => "token-value",
			fetchImpl,
		});
		return {
			adapter,
			fetchImpl: fetchImpl as unknown as ReturnType<typeof vi.fn>,
		};
	}

	it("posts the built query to the workspace endpoint with a bearer token", async () => {
		const { adapter, fetchImpl } = adapterWith({ tables: [] });
		await adapter.fetchLogExcerpts(SCOPE);

		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toContain("/v1/workspaces/ws-1/query");
		expect(init.method).toBe("POST");
		expect(init.headers.authorization).toBe("Bearer token-value");
		expect(JSON.parse(init.body).query).toContain("ago(1440m)");
	});

	it("honours the entry cap even if the platform returns more", async () => {
		const rows = Array.from({ length: 20 }, (_, i) => [`m${i}`]);
		const { adapter } = adapterWith({
			tables: [{ columns: [{ name: "Message" }], rows }],
		});

		const out = await adapter.fetchLogExcerpts({ ...SCOPE, maxEntries: 5 });
		expect(out).toHaveLength(5);
	});

	it("throws on a non-ok response, which the port degrades to unavailable", async () => {
		const { adapter } = adapterWith({}, false);
		await expect(adapter.fetchLogExcerpts(SCOPE)).rejects.toThrow(/403/);
	});

	it("does not put the query, which carries user terms, in the error", async () => {
		const { adapter } = adapterWith({}, false);
		await expect(
			adapter.fetchLogExcerpts({ ...SCOPE, terms: ["sensitive-term"] }),
		).rejects.toThrow(
			expect.objectContaining({
				message: expect.not.stringContaining("sensitive-term"),
			}),
		);
	});

	it("identifies itself so logs and the FR3 note name the source", async () => {
		const { adapter } = adapterWith({ tables: [] });
		expect(adapter.kind).toBe("azure-monitor");
		expect(adapter.label).toBe("Azure Monitor");
	});
});

describe("managed identity selection", () => {
	// A host with only user-assigned identities cannot resolve a credential
	// without being told which one. Getting this wrong fails the token request,
	// which the port degrades to "logs were not available" — indistinguishable
	// from a missing role assignment, and the reason this is tested rather than
	// left to a deploy to discover.
	const ORIGINAL = {
		feature: process.env.FABRIC_BUG_ANALYSIS_LOG_CLIENT_ID,
		sdk: process.env.AZURE_CLIENT_ID,
	};

	afterEach(() => {
		process.env.FABRIC_BUG_ANALYSIS_LOG_CLIENT_ID = ORIGINAL.feature;
		process.env.AZURE_CLIENT_ID = ORIGINAL.sdk;
	});

	it("reads the feature-scoped client id", () => {
		process.env.FABRIC_BUG_ANALYSIS_LOG_CLIENT_ID = " identity-a ";
		expect(configuredManagedIdentityClientId()).toBe("identity-a");
	});

	it("falls back to the SDK's own convention", () => {
		process.env.FABRIC_BUG_ANALYSIS_LOG_CLIENT_ID = "";
		process.env.AZURE_CLIENT_ID = "identity-b";
		expect(configuredManagedIdentityClientId()).toBe("identity-b");
	});

	it("prefers the feature-scoped id when both are set", () => {
		process.env.FABRIC_BUG_ANALYSIS_LOG_CLIENT_ID = "identity-a";
		process.env.AZURE_CLIENT_ID = "identity-b";
		expect(configuredManagedIdentityClientId()).toBe("identity-a");
	});

	it("stays undefined when neither is set, so system-assigned and local development still resolve", () => {
		process.env.FABRIC_BUG_ANALYSIS_LOG_CLIENT_ID = "";
		process.env.AZURE_CLIENT_ID = "";
		expect(configuredManagedIdentityClientId()).toBeUndefined();
	});
});
