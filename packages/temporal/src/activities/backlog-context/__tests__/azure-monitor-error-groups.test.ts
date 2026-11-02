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
	PLATFORM_NOISE_RULES,
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

	it("omits deploy noise classification for tenant-scoped queries", () => {
		const q = buildErrorGroupQuery(SCOPE, { requireTenantPredicate: true });
		for (const token of [
			"_proof",
			"_noise",
			"_revision",
			"_replica",
			...PLATFORM_NOISE_RULES.map((rule) => rule.id),
			"_setAside",
			"context canceled",
			"platform-noise",
			"AzureKeyVault",
		]) {
			expect(q).not.toContain(token);
		}
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

	it("separates set-aside telemetry from groups even without a group key or times", () => {
		const result = parseErrorGroupResponse({
			tables: [
				{
					columns,
					rows: [
						[
							"platform-noise",
							"",
							25,
							null,
							null,
							0,
							'["example-app"]',
							"[]",
							"",
						],
						[
							"platform",
							"ReplicaUnhealthy",
							7,
							"a",
							"b",
							0,
							"[]",
							"[]",
							"",
						],
					],
				},
			],
		});
		expect(result.platformNoiseSetAside).toBe(25);
		expect(result.platformNoiseApps).toEqual(["example-app"]);
		expect(result.groups.map((group) => group.kind)).toEqual(["platform"]);
	});
	it("returns zero set-aside events without telemetry", () => {
		expect(parseErrorGroupResponse(null).platformNoiseSetAside).toBe(0);
		expect(parseErrorGroupResponse(null).platformNoiseApps).toEqual([]);
	});

	it("converts the summarize envelope, parsing dynamic columns from JSON", () => {
		const { groups } = parseErrorGroupResponse({
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
		const { groups } = parseErrorGroupResponse({
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
		const { groups } = parseErrorGroupResponse({
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
		expect(parseErrorGroupResponse(null).groups).toEqual([]);
		expect(parseErrorGroupResponse({ tables: "x" }).groups).toEqual([]);
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

it("key-vault-canceled requires all proof clauses and event recheck", () => {
	expect(buildErrorGroupQuery(SCOPE)).toContain(
		"| join kind=leftouter (_noise0 | extend _proven0 = true) on _app, $left.TimeGenerated == $right.failAt",
	);
	const q = buildErrorGroupQuery(SCOPE);
	expect(q).toContain(
		'let _proof0_0 = _systemLogs\n| where _reason in ("SyncingSecretFromAzureKeyVaultForContainerAppSucceeded")\n| where isnotempty(_app)\n| project _app, okAt = TimeGenerated;\nlet _noise0_0 = _systemLogs\n| where _reason in ("SyncingSecretFromAzureKeyVaultForContainerAppFailed", "FetchingSecretFromAzureKeyVaultFailed") and _log endswith "context canceled"\n| where isnotempty(_app)\n| distinct _app, failAt = TimeGenerated\n| join kind=inner (_proof0_0) on _app\n| where failAt < okAt and okAt <= failAt + 15m\n| distinct _app, failAt;\nlet _noise0 = union _noise0_0\n| distinct _app, failAt;',
	);
	expect(q).toContain(
		'| extend _rule0 = coalesce(_proven0, false) and _reason in ("SyncingSecretFromAzureKeyVaultForContainerAppFailed", "FetchingSecretFromAzureKeyVaultFailed") and _log endswith "context canceled"',
	);
});

it("replica-scheduling requires all proof clauses and event recheck", () => {
	expect(buildErrorGroupQuery(SCOPE)).toContain(
		"| join kind=leftouter (_noise1 | extend _proven1 = true) on _revision, $left.TimeGenerated == $right.failAt",
	);
	const q = buildErrorGroupQuery(SCOPE);
	expect(q).toContain(
		'let _proof1_0 = _systemLogs\n| where _reason in ("AssigningReplica")\n| where isnotempty(_revision)\n| project _revision, okAt = TimeGenerated;\nlet _noise1_0 = _systemLogs\n| where _reason in ("AssigningReplicaFailed") and _log endswith "Waiting for infrastructure to be ready"\n| where isnotempty(_revision)\n| distinct _revision, failAt = TimeGenerated\n| join kind=inner (_proof1_0) on _revision\n| where failAt < okAt and okAt <= failAt + 2m\n| distinct _revision, failAt;\nlet _noise1 = union _noise1_0\n| distinct _revision, failAt;',
	);
	expect(q).toContain(
		'| extend _rule1 = coalesce(_proven1, false) and _reason in ("AssigningReplicaFailed") and _log endswith "Waiting for infrastructure to be ready"',
	);
});

it("revision-autoscaler requires all proof clauses and event recheck", () => {
	expect(buildErrorGroupQuery(SCOPE)).toContain(
		"| join kind=leftouter (_noise2 | extend _proven2 = true) on _revision, $left.TimeGenerated == $right.failAt",
	);
	const q = buildErrorGroupQuery(SCOPE);
	expect(q).toContain(
		'let _proof2_0 = _systemLogs\n| where _reason in ("KEDAScalersStarted")\n| where isnotempty(_revision)\n| project _revision, okAt = TimeGenerated;\nlet _noise2_0 = _systemLogs\n| where _reason in ("ScaledObjectCheckFailed") and _log endswith "Target resource doesn\'t exist"\n| where isnotempty(_revision)\n| distinct _revision, failAt = TimeGenerated\n| join kind=inner (_proof2_0) on _revision\n| where failAt <= okAt and okAt <= failAt + 2m\n| distinct _revision, failAt;\nlet _noise2 = union _noise2_0\n| distinct _revision, failAt;',
	);
	expect(q).toContain(
		'| extend _rule2 = coalesce(_proven2, false) and _reason in ("ScaledObjectCheckFailed") and _log endswith "Target resource doesn\'t exist"',
	);
});

it("replica-readiness requires all proof clauses and event recheck", () => {
	expect(buildErrorGroupQuery(SCOPE)).toContain(
		"| join kind=leftouter (_noise3 | extend _proven3 = true) on _replica, $left.TimeGenerated == $right.failAt",
	);
	const q = buildErrorGroupQuery(SCOPE);
	expect(q).toContain(
		'let _proof3_0 = _systemLogs\n| where _reason in ("StoppingContainer")\n| where isnotempty(_replica)\n| project _replica, okAt = TimeGenerated;\nlet _noise3_0 = _systemLogs\n| where _reason in ("ReplicaUnhealthy") and _log startswith "Readiness probe failed"\n| where isnotempty(_replica)\n| distinct _replica, failAt = TimeGenerated\n| join kind=inner (_proof3_0) on _replica\n| where okAt <= failAt and okAt >= failAt - 5m\n| distinct _replica, failAt;\nlet _proof3_1 = _systemLogs\n| where _reason in ("ContainerStarted")\n| where isnotempty(_replica)\n| project _replica, okAt = TimeGenerated;\nlet _noise3_1 = _systemLogs\n| where _reason in ("ReplicaUnhealthy") and _log startswith "Readiness probe failed"\n| where isnotempty(_replica)\n| distinct _replica, failAt = TimeGenerated\n| join kind=inner (_proof3_1) on _replica\n| where okAt <= failAt and okAt >= failAt - 2m\n| distinct _replica, failAt;\nlet _noise3 = union _noise3_0, _noise3_1\n| distinct _replica, failAt;',
	);
	expect(q).toContain(
		'| extend _rule3 = coalesce(_proven3, false) and _reason in ("ReplicaUnhealthy") and _log startswith "Readiness probe failed"',
	);
});

it("shares only the external metric reason, with teardown first", () => {
	const reasons = PLATFORM_NOISE_RULES.flatMap((rule) => [
		...rule.failureReasons,
	]);
	expect(
		reasons.filter((reason, index) => reasons.indexOf(reason) !== index),
	).toEqual(["FailedGetExternalMetric"]);
	expect(PLATFORM_NOISE_RULES.slice(4).map((rule) => rule.id)).toEqual([
		"autoscaler-teardown",
		"metrics-service-blip",
	]);
});
it("sums noise rows and unions capped apps", () => {
	const result = parseErrorGroupResponse({
		tables: [
			{
				columns: ["Kind", "GroupKey", "Occurrences", "Components"].map(
					(name) => ({ name }),
				),
				rows: [
					[
						"platform-noise",
						"key-vault-canceled",
						25,
						["example-app"],
					],
					[
						"platform-noise",
						"replica-readiness",
						3,
						["example-app", "example-app-2"],
					],
				],
			},
		],
	});
	expect(result.platformNoiseSetAside).toBe(28);
	expect(result.platformNoiseByRule).toEqual({
		"key-vault-canceled": 25,
		"replica-readiness": 3,
	});
	expect(result.platformNoiseApps).toEqual(["example-app", "example-app-2"]);
	expect(parseErrorGroupResponse(null).platformNoiseByRule).toEqual({});
});

it("removes explained events before grouping and reports rules outside the cap", () => {
	const q = buildErrorGroupQuery(SCOPE);
	expect(q.indexOf("let _proof0_0")).toBeLessThan(
		q.indexOf("| where _level in~"),
	);
	expect(q.indexOf("| where not(_setAside)")).toBeLessThan(
		q.indexOf('by Kind = "platform"'),
	);
	expect(q.indexOf('Kind = "platform-noise"')).toBeGreaterThan(
		q.indexOf("| take 25"),
	);
	expect(q).toContain(
		'| extend _noiseRule = case(_rule0, "key-vault-canceled", _rule1, "replica-scheduling", _rule2, "revision-autoscaler", _rule3, "replica-readiness", _rule4, "autoscaler-teardown", _rule5, "metrics-service-blip", "")',
	);
	expect(q).toContain("by GroupKey = _noiseRule");
	expect(q).toContain(
		'| where Occurrences > 0 | extend Kind = "platform-noise"',
	);
	expect(q).toContain('column_ifexists("RevisionName_s", "")');
	expect(q).toContain('column_ifexists("RevisionName", "")');
	expect(q).toContain('column_ifexists("ReplicaName_s", "")');
	expect(q).toContain('column_ifexists("ReplicaName", "")');
});

it("requires all clauses: A proof reason", () => {
	expect(buildErrorGroupQuery(SCOPE)).toContain(
		'let _proof4_0 = _systemLogs\n| where _reason in ("ScaledObjectDeleted")\n| where isnotempty(_revision)\n| project _revision, okAt = TimeGenerated;',
	);
});
it("requires all clauses: A failure reason", () => {
	expect(buildErrorGroupQuery(SCOPE)).toContain(
		'let _noise4_0 = _systemLogs\n| where _reason in ("FailedGetExternalMetric")\n| where isnotempty(_revision)',
	);
});
it("requires all clauses: A before direction", () => {
	expect(buildErrorGroupQuery(SCOPE)).toContain(
		"| where okAt <= failAt and okAt >= failAt - 1m",
	);
});
it("requires all clauses: A after direction", () => {
	expect(buildErrorGroupQuery(SCOPE)).toContain(
		"| where failAt <= okAt and okAt <= failAt + 1m",
	);
});
it("requires all clauses: A revision join", () => {
	expect(buildErrorGroupQuery(SCOPE)).toContain(
		"| join kind=inner (_proof4_0) on _revision",
	);
});
it("requires all clauses: A second revision join", () => {
	expect(buildErrorGroupQuery(SCOPE)).toContain(
		"| join kind=inner (_proof4_1) on _revision",
	);
});
it("requires all clauses: A union", () => {
	expect(buildErrorGroupQuery(SCOPE)).toContain(
		"let _noise4 = union _noise4_0, _noise4_1",
	);
});
it("requires all clauses: A event recheck", () => {
	expect(buildErrorGroupQuery(SCOPE)).toContain(
		'| extend _rule4 = coalesce(_proven4, false) and _reason in ("FailedGetExternalMetric")\n',
	);
});
it("requires all clauses: B failure reason", () => {
	expect(buildErrorGroupQuery(SCOPE)).toContain(
		'let _failures5 = materialize(_systemLogs\n| where _reason in ("FailedGetExternalMetric")\n| where isnotempty(_app)',
	);
});
it("requires all clauses: B minimum apps", () => {
	expect(buildErrorGroupQuery(SCOPE)).toContain("| where apps >= 3;");
});
it("requires all clauses: B simultaneous window", () => {
	expect(buildErrorGroupQuery(SCOPE)).toContain(
		"| where peerAt >= failAt - 1m and peerAt <= failAt + 1m",
	);
});
it("requires all clauses: B adjacent bins", () => {
	expect(buildErrorGroupQuery(SCOPE)).toContain(
		"| mv-expand _bucket = pack_array(_b - 1m, _b, _b + 1m) to typeof(datetime)) on _bucket",
	);
});
it("requires all clauses: B simultaneous join", () => {
	// kind=inner matters: the default innerunique keeps one left row per
	// bucket, so all but one app in a same-minute burst would go uncounted.
	expect(buildErrorGroupQuery(SCOPE)).toContain(
		"| extend _bucket = bin(failAt, 1m)\n| join kind=inner (_failures5\n| project peerApp = _app, peerAt = failAt\n| extend _b = bin(peerAt, 1m)",
	);
});
it("requires all clauses: B persistence join", () => {
	expect(buildErrorGroupQuery(SCOPE)).toContain(
		"| extend _bucket = bin(failAt, 15m)\n| join kind=inner (_failures5\n| project _app, peerAt = failAt\n| extend _b = bin(peerAt, 15m)",
	);
});
it("requires all clauses: B distinct apps", () => {
	expect(buildErrorGroupQuery(SCOPE)).toContain(
		"| summarize apps = count_distinct(peerApp) by _app, failAt",
	);
});
it("requires all clauses: B persistence window", () => {
	expect(buildErrorGroupQuery(SCOPE)).toContain(
		"| where peerAt >= failAt - 15m and peerAt <= failAt + 15m",
	);
});
it("requires all clauses: B persistence bins", () => {
	expect(buildErrorGroupQuery(SCOPE)).toContain(
		"| mv-expand _bucket = pack_array(_b - 15m, _b, _b + 15m) to typeof(datetime)) on _app, _bucket",
	);
});
it("requires all clauses: B distinct minutes", () => {
	expect(buildErrorGroupQuery(SCOPE)).toContain(
		"| summarize minutes = count_distinct(bin(peerAt, 1m)) by _app, failAt",
	);
});
it("requires all clauses: B maximum minutes", () => {
	expect(buildErrorGroupQuery(SCOPE)).toContain("| where minutes <= 3");
});
it("requires all clauses: B result join", () => {
	expect(buildErrorGroupQuery(SCOPE)).toContain(
		"| join kind=leftouter (_noise5 | extend _proven5 = true) on _app, $left.TimeGenerated == $right.failAt",
	);
});
it("requires all clauses: B event recheck", () => {
	expect(buildErrorGroupQuery(SCOPE)).toContain(
		'| extend _rule5 = coalesce(_proven5, false) and _reason in ("FailedGetExternalMetric")\n',
	);
});

it("requires all clauses: A second proof reason", () => {
	expect(buildErrorGroupQuery(SCOPE)).toContain(
		'let _proof4_1 = _systemLogs\n| where _reason in ("ScaledObjectDeleted")\n| where isnotempty(_revision)\n| project _revision, okAt = TimeGenerated;',
	);
});
it("requires all clauses: A result join", () => {
	expect(buildErrorGroupQuery(SCOPE)).toContain(
		"| join kind=leftouter (_noise4 | extend _proven4 = true) on _revision, $left.TimeGenerated == $right.failAt",
	);
});
