/**
 * The Azure Monitor half of the recurring-error scan: the aggregation query,
 * its response parser, and — the part that matters most — which query carries
 * the organization predicate. A shared workspace is read org-scoped by every
 * project except the one the deployment designates as its operator project.
 */

import type { ErrorGroupScope } from "@repo/ai/lib/log-context";
import { redactLogText } from "@repo/utils/log-redaction";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildErrorGroupQuery,
	configuredOperatorProjectId,
	createAzureMonitorLogSourceAdapter,
	createOperatorErrorScanAdapter,
	parseErrorGroupResponse,
} from "../azure-monitor-log-source";

const SCOPE: ErrorGroupScope = {
	lookbackMinutes: 1440,
	minOccurrences: 5,
	maxGroups: 25,
	organizationId: "org_example",
};

const ORG_PREDICATE = 'tostring(Properties["organizationId"]) == "org_example"';

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("buildErrorGroupQuery", () => {
	it("aggregates on the platform with every bound in the query", () => {
		const q = buildErrorGroupQuery(SCOPE);
		expect(q).toContain("ago(1440m)");
		expect(q).toContain("| summarize Occurrences = count()");
		expect(q).toContain("| where Occurrences >= 5");
		expect(q).toContain("| take 25");
		expect(q).toContain("by Kind = _kind, GroupKey = _key");
	});

	it("reads only error severity and above", () => {
		expect(buildErrorGroupQuery(SCOPE)).toContain("| where _sev >= 3");
	});

	it("bounds a hostile threshold and cap rather than trusting them", () => {
		const q = buildErrorGroupQuery({
			...SCOPE,
			minOccurrences: -4,
			maxGroups: 0.2,
			lookbackMinutes: 0,
		});
		expect(q).toContain("| where Occurrences >= 1");
		expect(q).toContain("| take 1");
		expect(q).toContain("ago(1m)");
	});

	it("carries the organization predicate when the store is shared", () => {
		const q = buildErrorGroupQuery(SCOPE, { requireTenantPredicate: true });
		expect(q).toContain(ORG_PREDICATE);
		// Applied before the aggregation, so no other tenant's row is counted.
		expect(q.indexOf(ORG_PREDICATE)).toBeLessThan(q.indexOf("summarize"));
	});

	it("omits the predicate only when asked to", () => {
		expect(buildErrorGroupQuery(SCOPE)).not.toContain("organizationId");
		expect(
			buildErrorGroupQuery(SCOPE, { requireTenantPredicate: false }),
		).not.toContain("organizationId");
	});

	it("fails closed on a shared store without an organization id", () => {
		expect(() =>
			buildErrorGroupQuery(
				{ ...SCOPE, organizationId: undefined },
				{ requireTenantPredicate: true },
			),
		).toThrow(/requires an organization id/);
	});

	it("adds Container Apps platform warnings and errors to an unscoped query", () => {
		const q = buildErrorGroupQuery(SCOPE);
		// Both schemas the environment can write, plus the empty anchor that
		// keeps the fuzzy union valid on a workspace with neither table.
		expect(q).toContain(
			"union isfuzzy=true ContainerAppSystemLogs_CL, ContainerAppSystemLogs, (datatable(TimeGenerated: datetime)[])",
		);
		expect(q).toContain('| where _level in~ ("Warning", "Error")');
		expect(q).toContain('by Kind = "platform", GroupKey = _reason');
		// The threshold and the cap apply to both sources together.
		expect(q.indexOf("union _appErrors, _platformEvents")).toBeLessThan(
			q.indexOf("| where Occurrences >= 5"),
		);
		// Console output is already in Application Insights; never read twice.
		expect(q).not.toContain("ContainerAppConsoleLogs");
	});

	it("leaves out platform warnings that are not failures", () => {
		const q = buildErrorGroupQuery(SCOPE);
		expect(q).toContain(
			'_reason !in~ ("Completed", "ScaledObjectDeleted")',
		);
	});

	it("builds a platform message the redaction step keeps legible", () => {
		const q = buildErrorGroupQuery(SCOPE);
		expect(q).toContain('strcat(_reason, " - ", _log)');
		// What that produces for a real Key Vault sync failure. With `: ` the
		// reason read as a secret's name and the whole message was masked.
		const message =
			"SyncingSecretFromAzureKeyVaultForContainerAppFailed - Failed to sync secret 'agent-service-secret' from Azure Key Vault";
		expect(redactLogText(message).text).toBe(message);
		expect(redactLogText(message.replace(" - ", ": ")).text).toContain(
			"[REDACTED]",
		);
	});

	it("never adds platform events to a tenant-scoped query, which they cannot be scoped by", () => {
		const q = buildErrorGroupQuery(SCOPE, { requireTenantPredicate: true });
		expect(q).not.toContain("ContainerAppSystemLogs");
		expect(q).toContain(ORG_PREDICATE);
	});

	it("escapes the organization id like any other literal", () => {
		const q = buildErrorGroupQuery(
			{ ...SCOPE, organizationId: 'x" or 1==1 //' },
			{ requireTenantPredicate: true },
		);
		expect(q).toContain('"x\\" or 1==1 //"');
	});
});

describe("parseErrorGroupResponse", () => {
	const columns = [
		"Kind",
		"GroupKey",
		"Occurrences",
		"FirstSeen",
		"LastSeen",
		"AffectedUsers",
		"Components",
		"SampleMessages",
		"ExceptionType",
	].map((name) => ({ name }));

	it("converts the summarize envelope, parsing dynamic columns from JSON", () => {
		const groups = parseErrorGroupResponse({
			tables: [
				{
					columns,
					rows: [
						[
							"exception",
							"System.TimeoutException at Checkout.Pay",
							"12",
							"2026-10-21T10:00:00Z",
							"2026-10-22T09:00:00Z",
							3,
							'["checkout-api"]',
							'["Timeout after 30s calling payments"]',
							"System.TimeoutException",
						],
					],
				},
			],
		});
		expect(groups).toEqual([
			{
				kind: "exception",
				key: "System.TimeoutException at Checkout.Pay",
				occurrences: 12,
				firstSeen: "2026-10-21T10:00:00Z",
				lastSeen: "2026-10-22T09:00:00Z",
				affectedUsers: 3,
				components: ["checkout-api"],
				sampleMessages: ["Timeout after 30s calling payments"],
				exceptionType: "System.TimeoutException",
			},
		]);
	});

	it("drops rows without a usable key, count or time range", () => {
		const groups = parseErrorGroupResponse({
			tables: [
				{
					columns,
					rows: [
						["trace", "", 9, "a", "b", 0, "[]", "[]", null],
						[
							"trace",
							"k",
							"not-a-number",
							"a",
							"b",
							0,
							"[]",
							"[]",
							null,
						],
						["trace", "k", 9, null, "b", 0, "[]", "[]", null],
					],
				},
			],
		});
		expect(groups).toEqual([]);
	});

	it("keeps a platform group's kind and reads an unknown kind as a trace", () => {
		const row = (kind: string) => [
			kind,
			"ReplicaUnhealthy",
			7,
			"2026-10-21T10:00:00Z",
			"2026-10-22T09:00:00Z",
			0,
			'["example-app"]',
			'["ReplicaUnhealthy: Readiness probe failed"]',
			"",
		];
		const groups = parseErrorGroupResponse({
			tables: [
				{ columns, rows: [row("platform"), row("something-else")] },
			],
		});
		expect(groups.map((group) => group.kind)).toEqual([
			"platform",
			"trace",
		]);
		expect(groups[0]?.exceptionType).toBeUndefined();
	});

	it("returns nothing for shapes it does not recognise", () => {
		expect(parseErrorGroupResponse(null)).toEqual([]);
		expect(parseErrorGroupResponse({ tables: "x" })).toEqual([]);
	});
});

describe("summarizeErrorGroups — tenant predicate by reach", () => {
	function adapter(options: {
		sharedStore: boolean;
		operatorErrorScan?: boolean;
	}) {
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ tables: [] }),
		});
		const built = createAzureMonitorLogSourceAdapter({
			workspaceId: "ws-1",
			getToken: async () => "token-value",
			fetchImpl: fetchImpl as unknown as typeof fetch,
			...options,
		});
		const sentQuery = () =>
			JSON.parse(fetchImpl.mock.calls[0][1].body as string)
				.query as string;
		return { built, sentQuery };
	}

	it("org-scopes a shared workspace", async () => {
		const { built, sentQuery } = adapter({ sharedStore: true });
		await built.summarizeErrorGroups?.(SCOPE);
		expect(sentQuery()).toContain(ORG_PREDICATE);
	});

	it("does not scope a dedicated workspace", async () => {
		const { built, sentQuery } = adapter({ sharedStore: false });
		await built.summarizeErrorGroups?.({
			...SCOPE,
			organizationId: undefined,
		});
		expect(sentQuery()).not.toContain("organizationId");
	});

	it("drops the predicate only for the operator scan", async () => {
		const { built, sentQuery } = adapter({
			sharedStore: true,
			operatorErrorScan: true,
		});
		await built.summarizeErrorGroups?.({
			...SCOPE,
			organizationId: undefined,
		});
		expect(sentQuery()).not.toContain("organizationId");
	});

	it("keeps excerpts org-scoped even on an operator adapter", async () => {
		const { built, sentQuery } = adapter({
			sharedStore: true,
			operatorErrorScan: true,
		});
		await built.fetchLogExcerpts({
			lookbackMinutes: 60,
			minSeverity: "error",
			maxEntries: 5,
			terms: [],
			organizationId: "org_example",
		});
		expect(sentQuery()).toContain(ORG_PREDICATE);
	});
});

describe("createOperatorErrorScanAdapter", () => {
	it("serves only the project the deployment names", () => {
		vi.stubEnv("FABRIC_BUG_ANALYSIS_LOG_WORKSPACE_ID", "ws-shared");
		vi.stubEnv(
			"FABRIC_RECURRING_ERRORS_OPERATOR_PROJECT_ID",
			"proj_operator",
		);
		expect(configuredOperatorProjectId()).toBe("proj_operator");

		const operator = createOperatorErrorScanAdapter("proj_operator");
		expect(operator?.sharedStore).toBe(true);
		expect(createOperatorErrorScanAdapter("proj_other")).toBeNull();
	});

	it("is off when no operator project or no workspace is configured", () => {
		vi.stubEnv("FABRIC_BUG_ANALYSIS_LOG_WORKSPACE_ID", "ws-shared");
		vi.stubEnv("FABRIC_RECURRING_ERRORS_OPERATOR_PROJECT_ID", "");
		expect(createOperatorErrorScanAdapter("proj_operator")).toBeNull();

		vi.stubEnv(
			"FABRIC_RECURRING_ERRORS_OPERATOR_PROJECT_ID",
			"proj_operator",
		);
		vi.stubEnv("FABRIC_BUG_ANALYSIS_LOG_WORKSPACE_ID", "");
		expect(createOperatorErrorScanAdapter("proj_operator")).toBeNull();
	});

	it("does not depend on the customer-facing shared-workspace opt-in", () => {
		vi.stubEnv("FABRIC_BUG_ANALYSIS_LOG_WORKSPACE_ID", "ws-shared");
		vi.stubEnv(
			"FABRIC_RECURRING_ERRORS_OPERATOR_PROJECT_ID",
			"proj_operator",
		);
		vi.stubEnv("FABRIC_BUG_ANALYSIS_LOG_ALLOW_SHARED_WORKSPACE", "false");
		expect(createOperatorErrorScanAdapter("proj_operator")).not.toBeNull();
	});
});
