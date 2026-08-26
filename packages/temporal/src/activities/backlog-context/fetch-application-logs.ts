/**
 * Application-log retrieval for bug analysis (Fizzy #1234) — the MCP ADAPTER.
 *
 * This is the only file that knows the mechanism. Everything security-relevant
 * (the feature gate, authorization, redaction, budgeting, the FR3 outcome)
 * lives above it in `@repo/ai/lib/log-context`, so replacing MCP with a
 * dedicated log connector after the FR4 feasibility review means rewriting
 * this file and nothing else.
 *
 * Discovery is deliberately capability-based rather than configuration-based:
 * a project "has log access configured" when one of the tenant's connected MCP
 * servers exposes a log-query tool. That follows the existing Notion fetcher in
 * `fetch-context.ts`, which probes candidate tool names the same way, and it
 * keeps the prototype free of a schema commitment the team has not approved
 * yet. ADR-017 records the explicit `Project` binding as the first follow-up.
 */
import {
	buildBugAnalysisLogContext,
	type LogQueryScope,
	type LogSourceAdapter,
} from "@repo/ai/lib/log-context";
import {
	getProjectLogSourceBinding,
	listMcpConfigsForTenant,
} from "@repo/database";
import { logger } from "@repo/logs";
import { getCachedMcpClientForConfig } from "@repo/mcp";
import { getBaseUrl } from "@repo/utils";
import type { RawLogEntry } from "@repo/utils/log-redaction";
import { guardToolWriteForReadOnly } from "../shared/read-only-gate";
import {
	resolveConfiguredLogSource,
	resolveProjectLogSource,
} from "./log-source-registry";

/**
 * Tool names that UNAMBIGUOUSLY denote a log query. Every entry names logs
 * explicitly, so a server exposing one is a log source and nothing else.
 * Probed in order; the first match on a connected server wins.
 *
 * Deliberately excluded, despite being the real tool names on major log
 * platforms: `run_kql_query` (Azure Monitor — but also Azure Data Explorer,
 * a general analytics database), `execute_query` (any database server), and
 * `search_issues` (Sentry — but also the Jira and GitHub MCP servers, and
 * Atlassian's is already an adopted integration here per ADR-002).
 *
 * Auto-discovering those would let a tenant's connected Jira server be
 * queried as if it were a log platform and its ISSUES rendered to the model
 * under an "Application Logs" heading — wrong evidence presented as runtime
 * fact, which is worse for a root-cause analysis than having no logs at all.
 * An operator who knows their platform opts in explicitly below.
 */
const LOG_QUERY_TOOL_NAMES = [
	"query_logs",
	"search_logs",
	"get_logs",
	"fetch_logs",
	"logs_query",
	"query_loki_logs",
] as const;

/**
 * Extra tool names an operator has declared to be log queries on their own
 * platform, comma-separated (e.g. `FABRIC_BUG_ANALYSIS_LOG_TOOLS=run_kql_query`).
 *
 * This is the escape hatch for the vendor names excluded above: naming one
 * here is a deliberate statement that on THIS deployment the tool queries
 * logs. Empty by default, so discovery is safe without configuration.
 */
function extraLogQueryToolNames(): string[] {
	return (process.env.FABRIC_BUG_ANALYSIS_LOG_TOOLS ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
}

interface McpToolLike {
	execute: (
		args: Record<string, unknown>,
		context: { toolCallId: string; messages: unknown[] },
	) => Promise<unknown>;
}

/**
 * Read the first present field from a row, trying the exact names first and
 * then case-insensitively.
 *
 * The case-insensitive pass is not defensive padding: Azure Monitor returns
 * `Message`, `TimeGenerated` and `SeverityLevel`, while a Loki or Elastic
 * wrapper returns `message`/`timestamp`/`level`. Matching only the lowercase
 * spellings made the adapter return ZERO entries for real Application
 * Insights rows — the feature found "no logs" against the most likely
 * platform, silently and every time.
 */
function pickField(row: Record<string, unknown>, names: string[]): unknown {
	for (const name of names) {
		if (row[name] !== undefined) {
			return row[name];
		}
	}
	const byLower = new Map(
		Object.keys(row).map((key) => [key.toLowerCase(), key] as const),
	);
	for (const name of names) {
		const actual = byLower.get(name.toLowerCase());
		if (actual !== undefined && row[actual] !== undefined) {
			return row[actual];
		}
	}
	return undefined;
}

/** Coerce one loosely-shaped record into a log entry, or `null` if it is not one. */
function toLogEntry(value: unknown): RawLogEntry | null {
	if (typeof value === "string") {
		return value.trim() ? { message: value } : null;
	}
	if (!value || typeof value !== "object") {
		return null;
	}
	const row = value as Record<string, unknown>;
	const message = pickField(row, [
		"message",
		"msg",
		"text",
		"body",
		"renderedMessage",
		"formattedMessage",
		"outerMessage",
	]);
	if (typeof message !== "string" || !message.trim()) {
		return null;
	}
	const timestamp = pickField(row, [
		"timestamp",
		"time",
		"timeGenerated",
		"ts",
	]);
	const severity = pickField(row, [
		"severity",
		"level",
		"severityLevel",
		"logLevel",
	]);

	// Only forward a flat, string-keyed bag; the redactor drops anything
	// still structured rather than guessing at it.
	const rawProperties = pickField(row, ["properties", "customDimensions"]);
	const properties =
		rawProperties && typeof rawProperties === "object"
			? (rawProperties as Record<string, unknown>)
			: undefined;

	return {
		message,
		timestamp: typeof timestamp === "string" ? timestamp : undefined,
		// Azure sends the severity as a NUMBER; stringify rather than drop it.
		severity:
			typeof severity === "string"
				? severity
				: typeof severity === "number"
					? String(severity)
					: undefined,
		properties,
	};
}

/**
 * MCP tool results arrive in several shapes. Accept the ones we have seen
 * rather than assuming one, and return `[]` for anything unrecognised — an
 * unparseable result is "no logs", never a crash.
 */
export function parseLogToolResult(result: unknown): RawLogEntry[] {
	const collect = (rows: unknown[]): RawLogEntry[] =>
		rows
			.map(toLogEntry)
			.filter((entry): entry is RawLogEntry => entry !== null);

	if (Array.isArray(result)) {
		// The MCP content-array shape: [{ type: "text", text: "..." }]
		const textParts = result
			.filter(
				(part): part is { type: string; text: string } =>
					!!part &&
					typeof part === "object" &&
					typeof (part as { text?: unknown }).text === "string",
			)
			.map((part) => part.text);
		if (textParts.length > 0) {
			return textParts.flatMap((text) => parseLogToolResult(text));
		}
		return collect(result);
	}

	if (typeof result === "string") {
		const trimmed = result.trim();
		if (!trimmed) {
			return [];
		}
		if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
			try {
				return parseLogToolResult(JSON.parse(trimmed));
			} catch {
				// Not JSON after all — fall through to line splitting.
			}
		}
		return collect(trimmed.split("\n").filter((line) => line.trim()));
	}

	if (result && typeof result === "object") {
		const obj = result as Record<string, unknown>;
		for (const key of [
			"entries",
			"rows",
			"results",
			"logs",
			"items",
			"data",
		]) {
			if (Array.isArray(obj[key])) {
				return collect(obj[key] as unknown[]);
			}
		}
		if (typeof obj.content !== "undefined") {
			return parseLogToolResult(obj.content);
		}
		const single = toLogEntry(obj);
		return single ? [single] : [];
	}

	return [];
}

/**
 * Bounds on capability discovery.
 *
 * Discovery probes connected MCP servers, and an unreachable server is
 * expensive: the shared client retries a connection failure up to three times
 * behind a 15s timeout, so one bad config can cost the better part of a
 * minute. Probing every config sequentially therefore had a worst case well
 * past this activity's 120s `startToCloseTimeout` — and because the activity
 * shares the Step-1 retry policy, Temporal would then retry the whole thing
 * up to three more times, holding the analysis open for minutes over an
 * optional context source.
 *
 * So: probe in small concurrent batches, cap each probe, and stop the whole
 * sweep at a wall-clock budget far below the activity timeout. Missing a log
 * source because discovery ran out of budget degrades to "not configured",
 * which is a supported outcome; blocking the analysis is not.
 */
const DISCOVERY_BUDGET_MS = 20_000;
const DISCOVERY_CONCURRENCY = 4;
const PER_PROBE_TIMEOUT_MS = 8_000;

/**
 * Ceiling on the actual log query, once a source is found. Larger than a
 * discovery probe because a real query does work, but still far below the
 * activity's 120s `startToCloseTimeout` so a hung platform degrades to
 * "unavailable" instead of burning the activity and its retries.
 */
const LOG_FETCH_TIMEOUT_MS = 30_000;

/** Reject if `work` has not settled within `ms`. Always clears its timer. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error("MCP log probe timed out")),
					ms,
				);
			}),
		]);
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}

/**
 * Find a connected MCP server exposing a log-query tool and wrap it as a
 * `LogSourceAdapter`. Returns `null` when the tenant has none — FR3's
 * "not configured", which is an ordinary outcome, not an error.
 */
export async function resolveMcpLogSourceAdapter(args: {
	projectId: string;
	userId: string;
	organizationId: string | null | undefined;
}): Promise<LogSourceAdapter | null> {
	const configs = await listMcpConfigsForTenant({
		userId: args.userId,
		organizationId: args.organizationId ?? null,
	});
	if (configs.length === 0) {
		return null;
	}

	const redirectUri = `${getBaseUrl()}/api/mcp/oauth/callback`;
	const deadline = Date.now() + DISCOVERY_BUDGET_MS;

	const probe = async (
		config: (typeof configs)[number],
	): Promise<LogSourceAdapter | null> => {
		try {
			const tools = await withTimeout(
				(async () => {
					const { client } = await getCachedMcpClientForConfig({
						configId: config.id,
						userId: args.userId,
						// Personal context is `undefined` here, not `null` —
						// the MCP client distinguishes "no org" from
						// "org unknown".
						organizationId: args.organizationId ?? undefined,
						redirectUri,
					});
					return client.tools();
				})(),
				PER_PROBE_TIMEOUT_MS,
			);

			// Unambiguous names first, then any the operator opted into, so a
			// server exposing both is read as the log tool it actually is.
			const candidates: string[] = [
				...LOG_QUERY_TOOL_NAMES,
				...extraLogQueryToolNames(),
			];
			const toolName = candidates.find((name) => tools[name]);
			if (!toolName) {
				return null;
			}

			const label =
				config.displayName ?? config.mcpServer?.name ?? "log source";
			const tool = tools[toolName] as unknown as McpToolLike;

			return {
				kind: "mcp",
				label,
				// Discovery probes only servers connected to THIS tenant
				// (`listMcpConfigsForTenant` filters by user/org), so the store
				// is dedicated by construction.
				sharedStore: false,
				async fetchLogExcerpts(
					scope: LogQueryScope,
				): Promise<RawLogEntry[]> {
					// Route through the worker-side read-only gate like every other
					// external MCP dispatch. A log query classifies as a read, so
					// this does not block today — it keeps the funnel honest if a
					// future tool name classifies otherwise.
					const blocked = await guardToolWriteForReadOnly(
						args.projectId,
						toolName,
					);
					if (blocked) {
						return [];
					}

					// Bounded like discovery is. Without this only DISCOVERY was
					// time-limited: a tool that accepts the call and then never
					// answers would block until Temporal's 120s activity ceiling
					// and be retried, costing minutes over an optional context
					// source. A timeout here surfaces as `unavailable`, which
					// the caller already degrades from.
					const raw = await withTimeout(
						tool.execute(
							{
								query: scope.terms.join(" "),
								terms: scope.terms,
								lookback_minutes: scope.lookbackMinutes,
								min_severity: scope.minSeverity,
								limit: scope.maxEntries,
							},
							{
								toolCallId: `bug-analysis-logs-${config.id}`,
								messages: [],
							},
						),
						LOG_FETCH_TIMEOUT_MS,
					);

					// The adapter honours the cap even if the server ignores it.
					return parseLogToolResult(raw).slice(0, scope.maxEntries);
				},
			};
		} catch (err) {
			logger.warn("[BugAnalysis] MCP config unusable for log discovery", {
				configId: config.id,
				err,
			});
		}
		return null;
	};

	for (let i = 0; i < configs.length; i += DISCOVERY_CONCURRENCY) {
		if (Date.now() >= deadline) {
			logger.warn(
				"[BugAnalysis] log-source discovery budget exhausted; treating as not configured",
				{ projectId: args.projectId, probed: i, total: configs.length },
			);
			return null;
		}
		const batch = configs.slice(i, i + DISCOVERY_CONCURRENCY);
		const found = (await Promise.all(batch.map(probe))).find(
			(adapter): adapter is LogSourceAdapter => adapter !== null,
		);
		if (found) {
			return found;
		}
	}

	return null;
}

/**
 * Pick the log source for this analysis.
 *
 * Order: the project's own binding, then the deployment's configured
 * provider, then MCP capability discovery. Each step is more explicit than
 * the one after it.
 *
 * A configured provider wins because it is explicit: an operator named it and
 * supplied its settings. MCP discovery is a capability probe — inference — so
 * it is the fallback. `null` from both is FR3's "not configured", an ordinary
 * outcome rather than an error.
 *
 * Which provider answered is not knowable from here, and deliberately so: both
 * paths return the same port type, so nothing above this line is bound to any
 * log platform.
 */
export async function resolveLogSourceAdapter(args: {
	projectId: string;
	userId: string;
	organizationId: string | null | undefined;
}): Promise<LogSourceAdapter | null> {
	// A project's own binding wins over everything. If it names a provider it
	// gets that provider or nothing — falling back would read a different
	// platform's logs than the project asked for, which is worse than reading
	// none.
	const binding = await getProjectLogSourceBinding(args.projectId);
	if (binding) {
		return resolveProjectLogSource(binding.provider, binding.config);
	}

	const configured = resolveConfiguredLogSource();
	if (configured) {
		return configured;
	}
	return resolveMcpLogSourceAdapter(args);
}

export interface FetchApplicationLogsInput {
	projectId: string;
	/** The user on whose behalf the analysis runs — authorization subject. */
	userId: string;
	organizationId: string | null | undefined;
	/** Terms narrowing the query to the item(s) under analysis. */
	terms: string[];
}

export interface FetchApplicationLogsOutput {
	/** Prompt section to append; empty when logs were not included. */
	clause: string;
	/** Why logs are or are not present — surfaced to the user for FR3. */
	note: string;
	status: string;
	entryCount: number;
}

/**
 * Temporal activity: fetch, redact and render application-log context.
 *
 * Never throws — the analysis must still run without logs (card NFR), so a
 * failure here is reported as an empty clause plus an explanatory note.
 */
export async function fetchApplicationLogsForBacklog(
	input: FetchApplicationLogsInput,
): Promise<FetchApplicationLogsOutput> {
	const outcome = await buildBugAnalysisLogContext({
		projectId: input.projectId,
		requesterUserId: input.userId,
		organizationId: input.organizationId,
		surface: "backlog-analysis",
		terms: input.terms,
		// No per-call scope override: nothing sets one. The bounds live in
		// `DEFAULT_LOG_SCOPE`, and ADR-017 records them as tunables for the
		// review. Optional parameters no caller passes are speculation, not
		// configurability — add them back with the caller that needs them.
		resolveAdapter: () =>
			resolveLogSourceAdapter({
				projectId: input.projectId,
				userId: input.userId,
				organizationId: input.organizationId,
			}),
	});

	return {
		clause: outcome.clause,
		note: outcome.note,
		status: outcome.status,
		entryCount: outcome.entryCount,
	};
}
