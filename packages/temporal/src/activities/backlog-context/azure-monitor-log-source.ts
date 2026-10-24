/**
 * Azure Monitor / Log Analytics adapter for bug-analysis log context
 * (Fizzy #1234) — the SECOND implementation of `LogSourceAdapter`.
 *
 * It exists for three reasons:
 *
 * 1. Fabric already emits its own telemetry to Application Insights, so this
 *    is the one log platform reachable today. Without it the feature could not
 *    be exercised end to end anywhere.
 * 2. It tests ADR-017's central claim — that the mechanism is swappable — by
 *    actually swapping it. Everything security-relevant (the flag, the
 *    permission check, redaction, budgets, the FR3 outcome) lives above the
 *    port and is untouched by this file.
 * 3. It gives the FR4 review real evidence about a direct connector rather
 *    than a paper comparison against MCP.
 *
 * It does NOT settle the mechanism question. Both adapters ship; which one a
 * deployment uses is configuration, and the ADR still asks the team to choose.
 *
 * Auth uses `DefaultAzureCredential`, so the worker's managed identity is used
 * in Azure and a developer's `az login` locally. No credential is stored by
 * Fabric and none is read from the database.
 */
import type {
	ErrorGroupScope,
	LogQueryScope,
	LogSeverity,
	LogSourceAdapter,
	RawErrorGroup,
} from "@repo/ai/lib/log-context";
import { logger } from "@repo/logs";
import type { RawLogEntry } from "@repo/utils/log-redaction";

/** The Log Analytics query API. Workspace-scoped, read-only. */
const LOG_ANALYTICS_ENDPOINT = "https://api.loganalytics.io";
const LOG_ANALYTICS_SCOPE = `${LOG_ANALYTICS_ENDPOINT}/.default`;

/**
 * Application Insights severity is an integer: 0 verbose, 1 information,
 * 2 warning, 3 error, 4 critical. The port speaks in names.
 */
const SEVERITY_FLOOR: Record<LogSeverity, number> = {
	info: 1,
	warning: 2,
	error: 3,
};

/** How many search terms reach the query, and how long each may be. */
const MAX_TERMS = 8;
const MAX_TERM_CHARS = 120;

/**
 * Render a value as a KQL string literal.
 *
 * The terms originate in a user-supplied analysis prompt, so they are
 * untrusted input being placed into a query language. Both KQL escape
 * characters are handled and control characters are stripped, so the value
 * cannot terminate the literal and start a new clause.
 */
export function kqlStringLiteral(value: string): string {
	const cleaned = value
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
		.replace(/[\u0000-\u001F\u007F]/g, " ")
		.slice(0, MAX_TERM_CHARS);
	return `"${cleaned.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Build the KQL for one scoped fetch. PURE and exported so the query can be
 * asserted in tests without a workspace.
 *
 * Bounds live in the query itself rather than being trimmed afterwards, so the
 * platform does the work and the response stays small.
 *
 * `requireTenantPredicate` is set for shared (deployment-wide) workspaces. The
 * predicate reads the organization id off each row's custom dimensions — a
 * value the caller cannot influence — and rows that do not carry one do not
 * match, so an unscopable query fails closed here as well as at the port.
 */
export function buildLogQuery(
	scope: LogQueryScope,
	options: { requireTenantPredicate?: boolean } = {},
): string {
	const floor = SEVERITY_FLOOR[scope.minSeverity] ?? SEVERITY_FLOOR.error;
	const terms = scope.terms
		.map((term) => term.trim())
		.filter(Boolean)
		.slice(0, MAX_TERMS);
	const requireTenant = options.requireTenantPredicate ?? false;

	const clauses = [
		"union AppTraces, AppExceptions",
		`| where TimeGenerated > ago(${Math.max(1, Math.floor(scope.lookbackMinutes))}m)`,
	];
	if (requireTenant) {
		const tenantOrgId = scope.organizationId;
		if (!tenantOrgId) {
			throw new Error(
				"Azure Monitor: a shared workspace query requires an organization id to scope it",
			);
		}
		clauses.push(
			`| where tostring(Properties["organizationId"]) == ${kqlStringLiteral(tenantOrgId)}`,
		);
	}
	clauses.push(
		"| extend _sev = coalesce(toint(SeverityLevel), 3)",
		`| where _sev >= ${floor}`,
		"| extend _msg = coalesce(Message, tostring(OuterMessage))",
		"| where isnotempty(_msg)",
	);

	if (terms.length > 0) {
		clauses.push(
			`| where _msg has_any (${terms.map(kqlStringLiteral).join(", ")})`,
		);
	}

	clauses.push(
		"| project TimeGenerated, SeverityLevel = _sev, Message = _msg, Properties",
		"| order by TimeGenerated desc",
		`| take ${Math.max(1, Math.floor(scope.maxEntries))}`,
	);

	return clauses.join("\n");
}

/** Caps on what one recurring-error group carries back from the platform. */
const MAX_GROUP_SAMPLES = 3;
const MAX_GROUP_COMPONENTS = 5;
/**
 * Container Apps system-log reasons logged at Warning that are not failures:
 * a container that exited with code 0, and a KEDA scaler removed along with
 * its revision.
 */
const PLATFORM_EVENTS_NOT_FAILURES = ["Completed", "ScaledObjectDeleted"];
/** Trace groups key on this much of the normalized message. */
const TRACE_KEY_CHARS = 300;

/**
 * Build the KQL that aggregates errors into recurring groups for the
 * recurring-error scan. PURE and exported for the same reason `buildLogQuery`
 * is: the tenant predicate is asserted in tests, not trusted.
 *
 * The aggregation runs on the platform. Exceptions group on Application
 * Insights' own `ProblemId`; traces group on their message with ids and
 * numbers masked, so one failure logged with a different request id each time
 * is one group rather than a thousand. The scan re-normalizes the key
 * code-side before fingerprinting, so this masking only has to be good enough
 * to keep the group count bounded.
 *
 * Container Apps platform events join the same groups when the query is not
 * tenant-scoped: warnings and errors from the environment's system log (a
 * failed probe, a container killed for memory, a secret that will not sync),
 * grouped on the event reason. Application output from the containers is not
 * read a second time from the console log: every service already reports it
 * to Application Insights, so it would only double each count. A workspace
 * without Container Apps has neither system-log table, and the empty anchor
 * keeps the fuzzy union valid there.
 *
 * `requireTenantPredicate` follows the same rule as `buildLogQuery`. Platform
 * events carry no organization, so a tenant-scoped query never includes them.
 * The one caller that passes `false` for a shared workspace is the
 * deployment's designated operator project (`createOperatorErrorScanAdapter`).
 */
export function buildErrorGroupQuery(
	scope: ErrorGroupScope,
	options: { requireTenantPredicate?: boolean } = {},
): string {
	const requireTenant = options.requireTenantPredicate ?? false;
	const window = `| where TimeGenerated > ago(${Math.max(1, Math.floor(scope.lookbackMinutes))}m)`;
	const clauses = ["let _appErrors = union AppTraces, AppExceptions", window];
	if (requireTenant) {
		const tenantOrgId = scope.organizationId;
		if (!tenantOrgId) {
			throw new Error(
				"Azure Monitor: a shared workspace query requires an organization id to scope it",
			);
		}
		clauses.push(
			`| where tostring(Properties["organizationId"]) == ${kqlStringLiteral(tenantOrgId)}`,
		);
	}
	clauses.push(
		"| extend _sev = coalesce(toint(SeverityLevel), 3)",
		`| where _sev >= ${SEVERITY_FLOOR.error}`,
		"| extend _msg = coalesce(Message, tostring(OuterMessage))",
		"| where isnotempty(_msg)",
		'| extend _kind = iff(isnotempty(ProblemId), "exception", "trace")',
		'| extend _masked = replace_regex(_msg, @"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", "<id>")',
		'| extend _masked = replace_regex(_masked, @"[0-9]+", "<n>")',
		`| extend _key = iff(_kind == "exception", tostring(ProblemId), substring(_masked, 0, ${TRACE_KEY_CHARS}))`,
		[
			"| summarize Occurrences = count()",
			"FirstSeen = min(TimeGenerated)",
			"LastSeen = max(TimeGenerated)",
			"AffectedUsers = dcountif(UserId, isnotempty(UserId))",
			`Components = make_set_if(AppRoleName, isnotempty(AppRoleName), ${MAX_GROUP_COMPONENTS})`,
			`SampleMessages = make_set(_msg, ${MAX_GROUP_SAMPLES})`,
			"ExceptionType = take_any(ExceptionType)",
		].join(", "),
		"  by Kind = _kind, GroupKey = _key;",
	);
	if (requireTenant) {
		clauses.push("_appErrors");
	} else {
		clauses.push(
			"let _platformEvents = union isfuzzy=true ContainerAppSystemLogs_CL, ContainerAppSystemLogs, (datatable(TimeGenerated: datetime)[])",
			window,
			// The classic table suffixes its columns; the resource-specific one
			// does not, and there `Type` carries the event's level.
			'| extend _level = iff(isnotempty(tostring(column_ifexists("Type_s", ""))), tostring(column_ifexists("Type_s", "")), tostring(column_ifexists("Type", "")))',
			'| where _level in~ ("Warning", "Error")',
			'| extend _reason = coalesce(tostring(column_ifexists("Reason_s", "")), tostring(column_ifexists("Reason", "")))',
			'| extend _app = coalesce(tostring(column_ifexists("ContainerAppName_s", "")), tostring(column_ifexists("ContainerAppName", "")))',
			'| extend _log = coalesce(tostring(column_ifexists("Log_s", "")), tostring(column_ifexists("Log", "")))',
			`| where isnotempty(_reason) and _reason !in~ (${PLATFORM_EVENTS_NOT_FAILURES.map((reason) => `"${reason}"`).join(", ")})`,
			// Not `reason: log`. A reason such as SyncingSecret...Failed is an
			// identifier the redaction step reads as a secret's name, and it
			// would then mask the whole message as that secret's value.
			'| extend _msg = strcat(_reason, " - ", _log)',
			[
				"| summarize Occurrences = count()",
				"FirstSeen = min(TimeGenerated)",
				"LastSeen = max(TimeGenerated)",
				`Components = make_set_if(_app, isnotempty(_app), ${MAX_GROUP_COMPONENTS})`,
				`SampleMessages = make_set(_msg, ${MAX_GROUP_SAMPLES})`,
			].join(", "),
			'  by Kind = "platform", GroupKey = _reason',
			'| extend AffectedUsers = 0, ExceptionType = "";',
			"union _appErrors, _platformEvents",
		);
	}
	clauses.push(
		`| where Occurrences >= ${Math.max(1, Math.floor(scope.minOccurrences))}`,
		"| order by Occurrences desc",
		`| take ${Math.max(1, Math.floor(scope.maxGroups))}`,
	);
	return clauses.join("\n");
}

/** A `dynamic` column arrives as a JSON string on the wire, or already parsed. */
function stringArray(value: unknown, cap: number): string[] {
	let parsed = value;
	if (typeof value === "string") {
		try {
			parsed = JSON.parse(value);
		} catch {
			return [];
		}
	}
	return Array.isArray(parsed)
		? parsed
				.filter((item): item is string => typeof item === "string")
				.slice(0, cap)
		: [];
}

/** An unrecognized kind reads as a trace, the group keyed on its message. */
function errorGroupKind(value: unknown): RawErrorGroup["kind"] {
	return value === "exception" || value === "platform" ? value : "trace";
}

/**
 * Convert the summarize response into error groups. Exported so it can be
 * tested against a captured payload. Rows that do not carry a usable key,
 * count and time range are dropped rather than guessed at.
 */
export function parseErrorGroupResponse(payload: unknown): RawErrorGroup[] {
	const groups: RawErrorGroup[] = [];
	for (const record of tableRecords(payload)) {
		const key = record.GroupKey;
		const occurrences = Number(record.Occurrences);
		if (
			typeof key !== "string" ||
			!key.trim() ||
			!Number.isFinite(occurrences) ||
			typeof record.FirstSeen !== "string" ||
			typeof record.LastSeen !== "string"
		) {
			continue;
		}
		const affectedUsers = Number(record.AffectedUsers);
		groups.push({
			kind: errorGroupKind(record.Kind),
			key,
			occurrences,
			firstSeen: record.FirstSeen,
			lastSeen: record.LastSeen,
			affectedUsers: Number.isFinite(affectedUsers) ? affectedUsers : 0,
			components: stringArray(record.Components, MAX_GROUP_COMPONENTS),
			sampleMessages: stringArray(
				record.SampleMessages,
				MAX_GROUP_SAMPLES,
			),
			exceptionType:
				typeof record.ExceptionType === "string" && record.ExceptionType
					? record.ExceptionType
					: undefined,
		});
	}
	return groups;
}

interface LogAnalyticsTable {
	name?: string;
	columns?: { name?: string }[];
	rows?: unknown[][];
}

/** Flatten the positional `{tables:[{columns, rows}]}` envelope into named records. */
function tableRecords(payload: unknown): Record<string, unknown>[] {
	if (!payload || typeof payload !== "object") {
		return [];
	}
	const tables = (payload as { tables?: LogAnalyticsTable[] }).tables;
	if (!Array.isArray(tables)) {
		return [];
	}
	const records: Record<string, unknown>[] = [];
	for (const table of tables) {
		const columns = (table.columns ?? []).map((c) => c?.name ?? "");
		const rows = Array.isArray(table.rows) ? table.rows : [];
		for (const row of rows) {
			if (!Array.isArray(row)) {
				continue;
			}
			const record: Record<string, unknown> = {};
			columns.forEach((name, index) => {
				if (name) {
					record[name] = row[index];
				}
			});
			records.push(record);
		}
	}
	return records;
}

/**
 * Convert the native `{tables:[{columns, rows}]}` envelope into log entries.
 *
 * Log Analytics returns rows as positional ARRAYS with a separate column list,
 * which nothing else in this feature speaks — the MCP adapter's parser handles
 * objects. Exported so the conversion can be tested against a captured real
 * response without a network call.
 */
export function parseLogAnalyticsResponse(payload: unknown): RawLogEntry[] {
	const entries: RawLogEntry[] = [];
	for (const record of tableRecords(payload)) {
		const message = record.Message;
		if (typeof message !== "string" || !message.trim()) {
			continue;
		}

		// `Properties` arrives as a JSON string on the wire.
		let properties: Record<string, unknown> | undefined;
		if (typeof record.Properties === "string" && record.Properties.trim()) {
			try {
				const parsed = JSON.parse(record.Properties);
				if (
					parsed &&
					typeof parsed === "object" &&
					!Array.isArray(parsed)
				) {
					properties = parsed as Record<string, unknown>;
				}
			} catch {
				// Not JSON — drop it rather than guess.
			}
		} else if (
			record.Properties &&
			typeof record.Properties === "object" &&
			!Array.isArray(record.Properties)
		) {
			properties = record.Properties as Record<string, unknown>;
		}

		entries.push({
			message,
			timestamp:
				typeof record.TimeGenerated === "string"
					? record.TimeGenerated
					: undefined,
			severity:
				record.SeverityLevel === undefined ||
				record.SeverityLevel === null
					? undefined
					: String(record.SeverityLevel),
			properties,
		});
	}
	return entries;
}

/**
 * The Log Analytics workspace this deployment reads bug-analysis logs from.
 *
 * An operator sets it deliberately; there is no per-project binding yet
 * (ADR-017 defers that). Empty means "no Azure Monitor source configured",
 * which is an ordinary FR3 outcome, not an error.
 */
export function configuredWorkspaceId(): string | undefined {
	const id = process.env.FABRIC_BUG_ANALYSIS_LOG_WORKSPACE_ID?.trim();
	return id ? id : undefined;
}

/**
 * Whether the deployment's own shared telemetry workspace may serve analyses
 * at all.
 *
 * The security review of Fizzy #1234 held that an environment-wide workspace
 * "shouldn't be a customer-facing source". Scoping alone leaves it live the
 * moment telemetry starts tagging organization ids, so serving it is now an
 * explicit operator opt-in: without this variable every org-context project
 * gets FR3's "no log source configured" instead of inheriting the deployment
 * default. Project bindings and MCP sources are unaffected — their tenant
 * boundary is the binding itself.
 */
export function sharedWorkspaceOptIn(): boolean {
	return (
		process.env.FABRIC_BUG_ANALYSIS_LOG_ALLOW_SHARED_WORKSPACE === "true"
	);
}

export interface AzureMonitorAdapterOptions {
	workspaceId: string;
	/**
	 * Whether this workspace outlives one tenant. The deployment's own
	 * environment-wide telemetry workspace does — every project inherits it,
	 * so its queries are forced through the organization predicate. A
	 * project-bound workspace is dedicated by construction: the project admin
	 * pointed THIS project at THAT workspace, and its logs do not carry Fabric
	 * org ids, so no predicate applies there.
	 */
	sharedStore: boolean;
	/**
	 * Set ONLY by `createOperatorErrorScanAdapter`: the recurring-error scan of
	 * the deployment's designated operator project may aggregate the shared
	 * workspace without the organization predicate, because that project's job
	 * is the deployment's own health. `fetchLogExcerpts` ignores it — excerpts
	 * for an analysis are always org-scoped on a shared store.
	 */
	operatorErrorScan?: boolean;
	/** Injected in tests; defaults to the real credential + fetch. */
	getToken?: () => Promise<string>;
	fetchImpl?: typeof fetch;
	/** Ceiling on the HTTP call itself. */
	timeoutMs?: number;
}

const DEFAULT_QUERY_TIMEOUT_MS = 30_000;

/**
 * Client id of the managed identity to authenticate as, when the host has more
 * than one — or, as on Container Apps, only user-assigned ones.
 *
 * Azure's own guidance: "When using Azure Identity client library, you need to
 * explicitly specify the user-assigned managed identity client ID." Without it
 * the credential chain asks for the SYSTEM-assigned identity, which a
 * user-assigned-only host does not have, and the token request fails — which
 * looks exactly like a missing role assignment while being nothing of the kind.
 *
 * Unset is correct for a system-assigned identity and for local development,
 * where the chain falls through to developer credentials. `AZURE_CLIENT_ID` is
 * the SDK's own convention and is honoured second, so a deployment that already
 * sets it needs nothing further.
 */
export function configuredManagedIdentityClientId(): string | undefined {
	const id =
		process.env.FABRIC_BUG_ANALYSIS_LOG_CLIENT_ID?.trim() ||
		process.env.AZURE_CLIENT_ID?.trim();
	return id ? id : undefined;
}

async function defaultGetToken(): Promise<string> {
	// Imported lazily so a deployment that never enables the feature does not
	// pay for the credential chain at module load.
	const { DefaultAzureCredential } = await import("@azure/identity");
	const managedIdentityClientId = configuredManagedIdentityClientId();
	const credential = new DefaultAzureCredential(
		managedIdentityClientId ? { managedIdentityClientId } : {},
	);

	let token: Awaited<ReturnType<typeof credential.getToken>>;
	try {
		token = await credential.getToken(LOG_ANALYTICS_SCOPE);
	} catch (cause) {
		// The port degrades this to "logs were not available", which is right for
		// the reader but leaves an operator with nothing to act on. Name the
		// configuration that is most often missing, since the platform's own
		// message ("unable to load the proper managed identity") does not.
		throw new Error(
			managedIdentityClientId
				? "Azure Monitor: could not acquire a Log Analytics token for the configured managed identity"
				: "Azure Monitor: could not acquire a Log Analytics token, and no managed identity client id is configured — a host with only user-assigned identities requires FABRIC_BUG_ANALYSIS_LOG_CLIENT_ID",
			{ cause },
		);
	}

	if (!token?.token) {
		throw new Error("Azure Monitor: no access token for Log Analytics");
	}
	return token.token;
}

/**
 * Build a `LogSourceAdapter` backed by a Log Analytics workspace.
 *
 * Returns the adapter without contacting Azure — resolution stays cheap, and a
 * credential or network failure surfaces on the fetch, where the port already
 * degrades to "unavailable".
 */
export function createAzureMonitorLogSourceAdapter(
	options: AzureMonitorAdapterOptions,
): LogSourceAdapter {
	const doFetch = options.fetchImpl ?? fetch;
	const getToken = options.getToken ?? defaultGetToken;
	const timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;

	const runQuery = async (query: string): Promise<unknown> => {
		const token = await getToken();
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await doFetch(
				`${LOG_ANALYTICS_ENDPOINT}/v1/workspaces/${encodeURIComponent(
					options.workspaceId,
				)}/query`,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({ query }),
					signal: controller.signal,
				},
			);

			if (!response.ok) {
				// The body can echo the query, which carries user terms, so it
				// is deliberately not logged.
				throw new Error(
					`Azure Monitor query failed with ${response.status}`,
				);
			}
			return await response.json();
		} finally {
			clearTimeout(timer);
		}
	};

	return {
		kind: "azure-monitor",
		label: "Azure Monitor",
		sharedStore: options.sharedStore,
		async fetchLogExcerpts(scope: LogQueryScope): Promise<RawLogEntry[]> {
			const payload = await runQuery(
				buildLogQuery(scope, {
					requireTenantPredicate: options.sharedStore,
				}),
			);
			const entries = parseLogAnalyticsResponse(payload);
			logger.info("[BugAnalysis] Azure Monitor returned log entries", {
				workspaceId: options.workspaceId,
				count: entries.length,
			});
			// Honour the cap even if the query somehow returned more.
			return entries.slice(0, scope.maxEntries);
		},
		async summarizeErrorGroups(
			scope: ErrorGroupScope,
		): Promise<RawErrorGroup[]> {
			const payload = await runQuery(
				buildErrorGroupQuery(scope, {
					requireTenantPredicate:
						options.sharedStore &&
						options.operatorErrorScan !== true,
				}),
			);
			const groups = parseErrorGroupResponse(payload);
			logger.info(
				"[RecurringErrors] Azure Monitor returned error groups",
				{
					workspaceId: options.workspaceId,
					count: groups.length,
					operatorScan: options.operatorErrorScan === true,
				},
			);
			return groups.slice(0, scope.maxGroups);
		},
	};
}

/**
 * The one project allowed to scan the deployment's shared telemetry workspace
 * WITHOUT the organization predicate: the operator's own project, which
 * tracks the health of the deployment itself rather than of a customer's
 * application.
 *
 * A deployment setting, never a project setting — a project admin cannot name
 * their own project here, which is the whole point. Unset means no project
 * has that reach.
 */
export function configuredOperatorProjectId(): string | undefined {
	const id = process.env.FABRIC_RECURRING_ERRORS_OPERATOR_PROJECT_ID?.trim();
	return id ? id : undefined;
}

/**
 * The recurring-error source for the designated operator project, or `null`
 * when `projectId` is not that project or no deployment workspace is
 * configured.
 *
 * Deliberately independent of `FABRIC_BUG_ANALYSIS_LOG_ALLOW_SHARED_WORKSPACE`:
 * that opt-in governs serving the shared workspace to customer-facing
 * analyses, which this is not. Naming the operator project is its own
 * explicit, deployment-level decision.
 */
export function createOperatorErrorScanAdapter(
	projectId: string,
	overrides: Pick<
		AzureMonitorAdapterOptions,
		"getToken" | "fetchImpl" | "timeoutMs"
	> = {},
): LogSourceAdapter | null {
	const operatorProjectId = configuredOperatorProjectId();
	const workspaceId = configuredWorkspaceId();
	if (!operatorProjectId || operatorProjectId !== projectId || !workspaceId) {
		return null;
	}
	return createAzureMonitorLogSourceAdapter({
		workspaceId,
		sharedStore: true,
		operatorErrorScan: true,
		...overrides,
	});
}

/**
 * This module's entry in the provider registry.
 *
 * Everything Azure-specific stops here: the registry, the port, redaction, the
 * property policy and the prompt assembly all speak `LogSourceAdapter` and
 * never mention a vendor. Another platform is another file exporting one of
 * these.
 */
export const azureMonitorProvider = {
	id: "azure-monitor",
	label: "Azure Monitor",
	fromEnvironment(): LogSourceAdapter | null {
		const workspaceId = configuredWorkspaceId();
		if (!workspaceId) {
			return null;
		}
		if (!sharedWorkspaceOptIn()) {
			logger.warn(
				"[BugAnalysis] deployment log workspace configured but not opted in for analysis use; treating as not configured",
				{ providerId: "azure-monitor" },
			);
			return null;
		}
		// The deployment default is the environment-wide telemetry workspace:
		// shared across every tenant this deployment serves, so its queries are
		// always forced through the organization predicate.
		return createAzureMonitorLogSourceAdapter({
			workspaceId,
			sharedStore: true,
		});
	},
	fromProjectConfig(
		config: Record<string, unknown>,
	): LogSourceAdapter | null {
		const workspaceId =
			typeof config.workspaceId === "string"
				? config.workspaceId.trim()
				: "";
		if (!workspaceId) {
			return null;
		}
		// A project binding may not name the deployment's own shared workspace.
		// The worker identity holds read on that workspace for THIS feature, so
		// honouring such a binding would hand any project admin the cross-
		// tenant reads the shared-store predicate exists to prevent — the same
		// escalation by another door. Workspace ids are GUIDs and Azure treats
		// them case-insensitively, so the guard compares that way too: an exact
		// match would be bypassed by re-casing the id.
		const deploymentWorkspace = configuredWorkspaceId()?.toLowerCase();
		if (
			deploymentWorkspace &&
			workspaceId.toLowerCase() === deploymentWorkspace
		) {
			logger.warn(
				"[BugAnalysis] project log-source binding names the deployment's shared telemetry workspace; refusing",
				{ providerId: "azure-monitor" },
			);
			return null;
		}
		return createAzureMonitorLogSourceAdapter({
			workspaceId,
			sharedStore: false,
		});
	},
};
