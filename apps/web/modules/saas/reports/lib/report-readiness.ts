/**
 * Pure derivation of a report instance's "readiness" — is it configured well
 * enough to generate, and what (if anything) is wrong with its config?
 *
 * This centralises the logic behind the redesigned Reports instance page: the
 * top-of-page issue banner, the connection status pill, and the readiness rail
 * checklist all read from one source of truth so they never disagree.
 *
 * It is intentionally a plain function (no React) so it can be unit-tested in
 * isolation and memoised by the caller. It performs NO network calls — it
 * derives state from data the page already has (template requirements, current
 * bindings, the latest on-demand `testConnections` diagnostics, and the
 * template's required parameters).
 */

/** A required data source declared by the template. */
interface ReadinessDataSource {
	key: string;
	name: string;
	required: boolean;
}

/** Minimal shape of a connection binding (we only need to know it exists + has an id). */
interface ReadinessBinding {
	id?: string;
}

/**
 * Minimal shape of an MCP connection diagnostic. Kept loose (string `outcome`)
 * so this module does not couple to the `@repo/temporal` enum and stays trivially
 * testable. Outcomes in practice: connected | auth_failed | unreachable |
 * zero_tools | no_read_only_tools | error.
 */
interface ReadinessDiagnostic {
	outcome: string;
	serverName?: string;
}

/** A parameter the template marks as required, plus whether it has a default. */
interface ReadinessParam {
	key: string;
	/** The current resolved value (from instance parameter defaults). */
	value?: string;
	/** A schema-level default — if present, the server will fill it, so an empty value is NOT "missing". */
	hasDefault?: boolean;
	/** Human label for messaging (falls back to `key`). */
	label?: string;
}

type ConnectionState =
	| "not_required"
	| "connected"
	| "not_configured"
	| "auth_expired"
	| "unreachable"
	| "error"
	// Connection is bound + healthy, but the data source's project/resource has
	// not been (re-)selected — i.e. recovery step 1 (reconnect) is done but
	// step 2 (re-select project) is still pending. See ReportConfigBanner.
	| "project_not_selected"
	// A required source is bound, but the MCP config it points at no longer
	// resolves for this user/tenant (deleted, reconnected → new id, or saved in
	// another context). It can't actually run — so it is NOT "connected": both
	// generation (CONFIG_NOT_FOUND) and save (validation) would fail. Surfaced as
	// "Reconnect required" and hard-blocks generation. See `accessibleMcpConfigIds`.
	| "connection_unavailable";

/**
 * Two-step connection-recovery model. After an MCP connection resets, recovery
 * needs BOTH (1) reconnecting the MCP server and (2) re-selecting the project in
 * the data source config. The banner uses this to enumerate the right step(s).
 */
interface RecoveryState {
	/** Step 1 — the MCP data source must be (re)connected. */
	needsReconnect: boolean;
	/** Step 2 — the project/resource must be (re-)selected for a connected source. */
	needsProjectSelect: boolean;
}

export type CheckStatus = "ok" | "warn" | "fail";
export type ReadinessTone = "success" | "warning" | "destructive" | "muted";

interface ReadinessCheck {
	key: "connection" | "params" | "skills" | "output";
	status: CheckStatus;
	label: string;
	note: string;
}

export interface ReportReadiness {
	connection: ConnectionState;
	connectionLabel: string;
	connectionTone: ReadinessTone;
	/** True once a `testConnections` has produced diagnostics. */
	connectionTested: boolean;
	missingRequiredParams: string[]; // labels (or keys) of required params with no value & no default
	/** Names of bound data sources whose project/resource still needs (re-)selecting (step 2). */
	missingProjects: string[];
	/** Two-step connection-recovery flags driving the banner's step-by-step guidance. */
	recovery: RecoveryState;
	checks: ReadinessCheck[];
	fails: number;
	warns: number;
	/** Hard blockers that should disable generation: no data source connected, or required params empty. */
	hardBlocked: boolean;
	/** One-line reason shown under a disabled Generate button. */
	blockReason?: string;
	verdict: { tone: ReadinessTone; title: string; subtitle: string };
}

export interface ReadinessInput {
	/** Whether the template declares ANY data source requirement at all. */
	templateNeedsDataSource: boolean;
	requiredDataSources: ReadinessDataSource[];
	bindings: Record<string, ReadinessBinding | undefined>;
	/** Latest on-demand connection-test diagnostics, if a test has run. */
	diagnostics?: ReadinessDiagnostic[];
	/**
	 * Keys of required data sources that are BOUND but cannot resolve to any MCP
	 * config for the current user — neither the stored id, nor a self-heal fallback
	 * to the user's own config for that server (see `resolveReportMcpConfig`). The
	 * caller derives this (it knows the user's configs + the per-source server
	 * match). Such a source is surfaced as `connection_unavailable` ("Reconnect
	 * required") and hard-blocks generation, instead of being optimistically shown
	 * as "connected". Omit/empty to skip the check (back-compat).
	 */
	unresolvableDataSources?: string[];
	requiredParams: ReadinessParam[];
	skillsCount: number;
	outputFormat?: string;
	dataSourceLabel?: string;
	/**
	 * Names of required data sources that ARE connected but still need their
	 * project/resource (re-)selected — recovery step 2. The caller derives this
	 * (e.g. bound + resources available but none picked); empty when unknown.
	 */
	dataSourcesMissingProject?: string[];
}

const CONNECTED_TONE: Record<ConnectionState, ReadinessTone> = {
	not_required: "muted",
	connected: "success",
	not_configured: "warning",
	auth_expired: "warning",
	unreachable: "destructive",
	error: "destructive",
	project_not_selected: "warning",
	connection_unavailable: "destructive",
};

const CONNECTED_LABEL: Record<ConnectionState, string> = {
	not_required: "No connection required",
	connected: "Connected",
	not_configured: "Not configured",
	auth_expired: "Auth expired",
	unreachable: "Unreachable",
	error: "Test failed",
	project_not_selected: "Project not selected",
	connection_unavailable: "Reconnect required",
};

/** Connection states that mean the MCP data source itself must be (re)connected. */
const NEEDS_RECONNECT: ReadonlySet<ConnectionState> = new Set([
	"not_configured",
	"auth_expired",
	"unreachable",
	"error",
	"connection_unavailable",
]);

/**
 * Pick the most relevant bad outcome from a set of diagnostics. Severity order:
 * unreachable > error-ish > auth → so the page surfaces the most actionable
 * problem first. Returns "connected" when nothing is wrong.
 */
function worstOutcome(diagnostics: ReadinessDiagnostic[]): ConnectionState {
	const outcomes = diagnostics.map((d) => d.outcome);
	if (outcomes.includes("unreachable")) {
		return "unreachable";
	}
	if (
		outcomes.some((o) =>
			["error", "zero_tools", "no_read_only_tools"].includes(o),
		)
	) {
		return "error";
	}
	if (outcomes.includes("auth_failed")) {
		return "auth_expired";
	}
	return "connected";
}

function isEmpty(value?: string): boolean {
	return !value || value.trim().length === 0;
}

export function computeReportReadiness(input: ReadinessInput): ReportReadiness {
	const {
		templateNeedsDataSource,
		requiredDataSources,
		bindings,
		diagnostics,
		unresolvableDataSources,
		requiredParams,
		skillsCount,
		outputFormat,
		dataSourceLabel,
		dataSourcesMissingProject,
	} = input;

	const connectionTested =
		Array.isArray(diagnostics) && diagnostics.length > 0;

	// ── Connection state ──────────────────────────────────────────────────────
	// Only data sources flagged `required` can hard-block generation. Optional
	// ones never block.
	const requiredOnes = requiredDataSources.filter((d) => d.required);
	const requiredUnbound = requiredOnes.filter((d) => !bindings[d.key]?.id);
	const anyBound = requiredDataSources.some((d) => bindings[d.key]?.id);

	// A required source can be "bound" yet not resolve to ANY config the current
	// user can use — neither the stored id nor a self-heal fallback to their own
	// config for that server (deleted / reconnected → new id / teammate's config /
	// wrong context). Such a binding can't run (CONFIG_NOT_FOUND) and save is
	// rejected, so it must NOT show as "connected". The caller derives this set
	// (it knows the user's configs + the per-source server match).
	const unresolvableSet = new Set(unresolvableDataSources ?? []);
	const requiredBoundUnavailable = requiredOnes.filter(
		(d) => unresolvableSet.has(d.key) && Boolean(bindings[d.key]?.id),
	);

	let connection: ConnectionState;
	if (!templateNeedsDataSource) {
		connection = "not_required";
	} else if (requiredUnbound.length > 0) {
		connection = "not_configured";
	} else if (requiredBoundUnavailable.length > 0) {
		// Bound, but the saved connection no longer resolves — honest "broken",
		// not optimistic "connected". Takes precedence over a (necessarily stale)
		// passing test: a real test of an inaccessible config can't succeed.
		connection = "connection_unavailable";
	} else if (connectionTested) {
		// At least the required sources are bound; trust the live test result.
		connection = worstOutcome(diagnostics ?? []);
	} else {
		// Bound but not yet tested — treat as connected (don't fabricate a problem).
		connection =
			anyBound || requiredOnes.length === 0
				? "connected"
				: "not_configured";
	}

	// Recovery step 2: the source is connected & healthy, but its project/resource
	// hasn't been (re-)selected. Only applies when no reconnect is pending — a
	// reconnect-needed state already implies step 2 will follow.
	const missingProjects = dataSourcesMissingProject ?? [];
	if (connection === "connected" && missingProjects.length > 0) {
		connection = "project_not_selected";
	}

	const connectionStatus: CheckStatus =
		connection === "not_configured" ||
		connection === "connection_unavailable"
			? "fail"
			: connection === "connected" || connection === "not_required"
				? "ok"
				: "warn";

	const connectionNote: string = (() => {
		switch (connection) {
			case "not_required":
				return "This template runs without an external connection";
			case "connected":
				return connectionTested
					? "All checks passed"
					: "Run “Test connections” to verify";
			case "not_configured":
				return "Connect a data source to enable generation";
			case "auth_expired":
				return "Reconnect the integration to continue";
			case "unreachable":
				return "Timed out — may be transient, try again";
			case "error":
				return "The data source returned an error — check the values below";
			case "project_not_selected":
				return "Re-select your project in the connection settings below";
			case "connection_unavailable":
				return "This saved connection is no longer available — re-select it below";
		}
	})();

	const connectionLabelText: string = (() => {
		switch (connection) {
			case "connected":
				return "Data source connected";
			case "not_configured":
				return "No data source connected";
			case "auth_expired":
				return "Authorization expired";
			case "unreachable":
				return "Data source unreachable";
			case "error":
				return "Connection test failed";
			case "not_required":
				return "No data source required";
			case "project_not_selected":
				return "Project not selected";
			case "connection_unavailable":
				return "Connection no longer available";
		}
	})();

	// ── Required parameters ───────────────────────────────────────────────────
	const missing = requiredParams.filter(
		(p) => isEmpty(p.value) && !p.hasDefault,
	);
	const missingLabels = missing.map((p) => p.label ?? p.key);
	const paramsStatus: CheckStatus = missing.length > 0 ? "fail" : "ok";

	// ── Build checklist ─────────────────────────────────────────────────────────
	const checks: ReadinessCheck[] = [
		{
			key: "connection",
			status: connectionStatus,
			label: connectionLabelText,
			note: connectionNote,
		},
		{
			key: "params",
			status: paramsStatus,
			label:
				missing.length > 0
					? `${missing.length} required parameter${missing.length === 1 ? "" : "s"} missing`
					: "Required parameters set",
			note:
				missing.length > 0
					? `Fill in: ${missingLabels.join(", ")}`
					: requiredParams.length > 0
						? `${requiredParams.length} required value${requiredParams.length === 1 ? "" : "s"} provided`
						: "No required parameters",
		},
		{
			key: "skills",
			status: "ok",
			label: "Skills ready",
			note:
				skillsCount > 0
					? `${skillsCount} injected from template`
					: "No template skills",
		},
		{
			key: "output",
			status: "ok",
			label: "Output configured",
			note:
				[outputFormat, dataSourceLabel].filter(Boolean).join(" · ") ||
				"Ready",
		},
	];

	const fails = checks.filter((c) => c.status === "fail").length;
	const warns = checks.filter((c) => c.status === "warn").length;
	const hardBlocked = fails > 0;

	let blockReason: string | undefined;
	if (connection === "not_configured" && missing.length > 0) {
		blockReason =
			"Connect a data source and fill the required parameters to generate.";
	} else if (connection === "not_configured") {
		blockReason = "Connect a data source to enable generation.";
	} else if (connection === "connection_unavailable" && missing.length > 0) {
		blockReason =
			"Re-select this report’s data source connection and fill the required parameters to generate.";
	} else if (connection === "connection_unavailable") {
		blockReason =
			"This report’s data source connection is no longer available — re-select it to generate.";
	} else if (missing.length > 0) {
		blockReason = `Fill the required parameter${missing.length === 1 ? "" : "s"}: ${missingLabels.join(", ")}.`;
	}

	const recovery: RecoveryState = {
		needsReconnect: NEEDS_RECONNECT.has(connection),
		needsProjectSelect:
			NEEDS_RECONNECT.has(connection) ||
			connection === "project_not_selected",
	};

	const verdict = hardBlocked
		? {
				tone: "destructive" as const,
				title: "Not ready to generate",
				subtitle: `${fails} item${fails === 1 ? "" : "s"} need${fails === 1 ? "s" : ""} attention`,
			}
		: warns > 0
			? {
					tone: "warning" as const,
					title: "Ready, with warnings",
					subtitle: `${warns} item${warns === 1 ? "" : "s"} to review`,
				}
			: {
					tone: "success" as const,
					title: "Ready to generate",
					subtitle: "All checks passed",
				};

	return {
		connection,
		connectionLabel: CONNECTED_LABEL[connection],
		connectionTone: CONNECTED_TONE[connection],
		connectionTested,
		missingRequiredParams: missingLabels,
		missingProjects,
		recovery,
		checks,
		fails,
		warns,
		hardBlocked,
		blockReason,
		verdict,
	};
}
