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
	LogQueryScope,
	LogSeverity,
	LogSourceAdapter,
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

interface LogAnalyticsTable {
	name?: string;
	columns?: { name?: string }[];
	rows?: unknown[][];
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
	if (!payload || typeof payload !== "object") {
		return [];
	}
	const tables = (payload as { tables?: LogAnalyticsTable[] }).tables;
	if (!Array.isArray(tables) || tables.length === 0) {
		return [];
	}

	const entries: RawLogEntry[] = [];
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

			const message = record.Message;
			if (typeof message !== "string" || !message.trim()) {
				continue;
			}

			// `Properties` arrives as a JSON string on the wire.
			let properties: Record<string, unknown> | undefined;
			if (
				typeof record.Properties === "string" &&
				record.Properties.trim()
			) {
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

	return {
		kind: "azure-monitor",
		label: "Azure Monitor",
		sharedStore: options.sharedStore,
		async fetchLogExcerpts(scope: LogQueryScope): Promise<RawLogEntry[]> {
			const token = await getToken();
			const query = buildLogQuery(scope, {
				requireTenantPredicate: options.sharedStore,
			});

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

				const payload = await response.json();
				const entries = parseLogAnalyticsResponse(payload);
				logger.info(
					"[BugAnalysis] Azure Monitor returned log entries",
					{
						workspaceId: options.workspaceId,
						count: entries.length,
					},
				);
				// Honour the cap even if the query somehow returned more.
				return entries.slice(0, scope.maxEntries);
			} finally {
				clearTimeout(timer);
			}
		},
	};
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
