"use client";

/**
 * Admin "Audit Log via API key" explorer.
 *
 * Lets Fabric staff dogfood the public `/api/v1/audit-log` REST endpoint
 * by pasting a customer's API key and base URL. The actual data fetch
 * goes through the server-side admin proxy procedure
 * (`orpc.admin.auditLog.viaApiKey`) so the staff browser never needs
 * cross-origin CORS open to the customer's API.
 *
 * The body of the explorer reuses the exact same viewer components that
 * power the in-product audit-log page at `/app/{slug}/settings/audit-log`
 * (filters chips, table with columns + tooltips, sort dropdown, export
 * split-button, pagination footer, row drawer) — driven through a
 * `dataSource` override on `<AuditLogTable>` and `<AuditLogExportButton>`
 * that swaps the standard `audit.list` / `audit.export` calls for the
 * staff proxy. This keeps the explorer and the in-product viewer
 * pixel-identical so the only difference is the data origin.
 *
 * Differences vs the in-product viewer (necessary, not cosmetic):
 *   - No member filter chip (the REST surface has no view of the
 *     customer's user directory).
 *   - No project filter chip (same reason).
 *   - No stats strip (the proxy returns rows-only; we don't aggregate).
 *   - No auto-refresh + no API-key drawer (staff-only surface; not
 *     managing the customer's keys from here).
 *   - The "Trace this flow" button on the row drawer is hidden — the
 *     trace endpoint reads from in-process spans, which we can't reach
 *     through the public REST surface.
 *
 * UI shape per the spec:
 *   - Editorial header (serif h1, uppercase staff label, dot-grid texture)
 *   - Explanation block describing the tenant-resolution semantics
 *   - Two-input "Connect" card (base URL + API key), with recent base URLs
 *     persisted to localStorage. The API key is NEVER persisted.
 *   - Once connected, the full audit-log viewer (filters + table + drawer)
 *     drops in below the Connect card.
 *
 * Accessibility:
 *   - All form inputs have visible labels (sr-only fallback never used).
 *   - The API-key field is `type="password"` by default with a show/hide
 *     toggle button (`aria-pressed` reflecting state).
 *   - The "Connect" button is the explicit submit; pressing Enter inside
 *     the api-key input triggers it.
 *   - The "Open API documentation" link uses `rel="noopener noreferrer"`.
 *   - Empty-state and error-state regions use `role="status"` so screen
 *     readers announce changes without re-reading the whole table.
 */

import { AuditLogActivePills } from "@saas/settings/components/audit-log/AuditLogActivePills";
import type { AuditLogExportDataSource } from "@saas/settings/components/audit-log/AuditLogExportButton";
import { AuditLogExportButton } from "@saas/settings/components/audit-log/AuditLogExportButton";
import { AuditLogFilters } from "@saas/settings/components/audit-log/AuditLogFilters";
import { AuditLogMetadataDrawer } from "@saas/settings/components/audit-log/AuditLogMetadataDrawer";
import { AuditLogSortControl } from "@saas/settings/components/audit-log/AuditLogSortControl";
import type { AuditLogStatsStripDataSource } from "@saas/settings/components/audit-log/AuditLogStatsStrip";
import { AuditLogStatsStrip } from "@saas/settings/components/audit-log/AuditLogStatsStrip";
import type { AuditLogTableDataSource } from "@saas/settings/components/audit-log/AuditLogTable";
import { AuditLogTable } from "@saas/settings/components/audit-log/AuditLogTable";
import {
	type AuditLogFiltersState,
	type AuditSortOrder,
	EMPTY_FILTERS_STATE,
	type filtersStateToApi,
} from "@saas/settings/components/audit-log/types";
import { orpcClient } from "@shared/lib/orpc-client";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	AlertCircleIcon,
	BookOpenTextIcon,
	EyeIcon,
	EyeOffIcon,
	Loader2Icon,
	PlugIcon,
	PlugZapIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";

/** localStorage key for the persisted base-URL combobox suggestions. */
const BASE_URL_HISTORY_KEY = "fabric.adminAuditLogExplorer.baseUrlHistory";

/** Cap on remembered base URLs — most-recent-first. */
const BASE_URL_HISTORY_MAX = 8;

/** Default base URL when nothing is persisted. */
const DEFAULT_BASE_URL_DEV = "http://localhost:3001";

/** Cap on the client-side export aggregation. Mirrors the REST cap. */
const EXPORT_ROW_CAP = 50_000;

/** Page-size used when paging through the proxy during export aggregation. */
const EXPORT_PAGE_SIZE = 200;

export type ProxyRow = {
	id: string;
	organizationId: string | null;
	userId: string | null;
	actorType: string;
	actor: { email: string | null; name: string | null };
	impersonatedById: string | null;
	action: string;
	category: string;
	severity: string;
	outcome: string;
	resource: {
		type: string | null;
		id: string | null;
		name: string | null;
	} | null;
	projectId: string | null;
	ipAddress: string | null;
	userAgent: string | null;
	correlationId: string | null;
	sessionId: string | null;
	metadata: unknown;
	durationMs: number | null;
	createdAt: string;
};

/**
 * Row shape the in-product viewer expects (`AuditLogTable`,
 * `AuditLogMetadataDrawer`). The proxy procedure returns a slightly
 * different shape (nested `actor` / `resource` objects, `correlationId`
 * lifted to a top-level field). This adapter normalises the proxy
 * response so the existing render path works untouched.
 */
type ViewerRow = {
	id: string;
	organizationId: string | null;
	userId: string | null;
	actorType: string;
	actorEmailSnapshot: string | null;
	actorNameSnapshot: string | null;
	impersonatedById: string | null;
	action: string;
	category: string;
	severity: string;
	outcome: string;
	resourceType: string | null;
	resourceId: string | null;
	resourceName: string | null;
	projectId: string | null;
	ipAddress: string | null;
	userAgent: string | null;
	requestId: string | null;
	sessionId: string | null;
	metadata: unknown;
	durationMs: number | null;
	createdAt: Date;
};

function remapProxyRowToViewer(row: ProxyRow): ViewerRow {
	// Lift the correlationId into the metadata so the in-product viewer's
	// row → correlation prefix → trace button logic continues to work. We
	// keep the proxy's top-level `correlationId` as a back-up readable
	// field; the viewer only looks at `metadata.correlationId`.
	const baseMetadata =
		row.metadata && typeof row.metadata === "object"
			? { ...(row.metadata as Record<string, unknown>) }
			: {};
	if (row.correlationId && baseMetadata.correlationId === undefined) {
		baseMetadata.correlationId = row.correlationId;
	}
	return {
		id: row.id,
		organizationId: row.organizationId,
		userId: row.userId,
		actorType: row.actorType,
		actorEmailSnapshot: row.actor?.email ?? null,
		actorNameSnapshot: row.actor?.name ?? null,
		impersonatedById: row.impersonatedById,
		action: row.action,
		category: row.category,
		severity: row.severity,
		outcome: row.outcome,
		resourceType: row.resource?.type ?? null,
		resourceId: row.resource?.id ?? null,
		resourceName: row.resource?.name ?? null,
		projectId: row.projectId,
		ipAddress: row.ipAddress,
		userAgent: row.userAgent,
		requestId: row.correlationId,
		sessionId: row.sessionId,
		metadata: baseMetadata,
		durationMs: row.durationMs,
		createdAt: new Date(row.createdAt),
	};
}

interface TenantInfo {
	kind: "organization" | "personal";
	organizationId: string | null;
	userId: string | null;
	keyType: "organization" | "personal";
	keyPrefix: string;
}

function loadBaseUrlHistory(): string[] {
	if (typeof window === "undefined") {
		return [];
	}
	try {
		const raw = window.localStorage.getItem(BASE_URL_HISTORY_KEY);
		if (!raw) {
			return [];
		}
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) {
			return [];
		}
		return parsed.filter((s): s is string => typeof s === "string");
	} catch {
		return [];
	}
}

function persistBaseUrlHistory(history: string[]): void {
	if (typeof window === "undefined") {
		return;
	}
	try {
		window.localStorage.setItem(
			BASE_URL_HISTORY_KEY,
			JSON.stringify(history.slice(0, BASE_URL_HISTORY_MAX)),
		);
	} catch {
		// Quota exceeded or storage disabled — silently skip.
	}
}

/**
 * Decide which base URL to default to on first render. We never read the
 * API key from storage — that lives in component state only.
 *
 * Preference order:
 *  1. Most-recently-used base URL from localStorage history.
 *  2. The current browser origin (so the explorer "just works" against
 *     the same Fabric deployment the staff member is already signed
 *     into — staging hits staging, prod hits prod, local hits local).
 *  3. Hardcoded dev fallback for SSR / no-window environments.
 */
function pickDefaultBaseUrl(history: string[]): string {
	if (history.length > 0 && history[0]) {
		return history[0];
	}
	if (
		typeof window !== "undefined" &&
		typeof window.location?.origin === "string" &&
		isHttpUrl(window.location.origin)
	) {
		return window.location.origin;
	}
	return DEFAULT_BASE_URL_DEV;
}

function isHttpUrl(value: string): boolean {
	try {
		const u = new URL(value);
		return u.protocol === "http:" || u.protocol === "https:";
	} catch {
		return false;
	}
}

/**
 * Flatten the in-product viewer's filter shape (Date objects, string
 * array dimensions like `actions`, `categories`, `severities`,
 * `outcomes`) onto the proxy procedure's scalar input fields (`from`,
 * `to`, `action`, `category`, `severity`, `outcome`). The proxy is
 * single-select for action/category/severity/outcome — we forward the
 * first non-empty entry per dimension.
 */
function flattenFilterForProxy(filter: ReturnType<typeof filtersStateToApi>): {
	from?: string;
	to?: string;
	action?: string;
	category?: string;
	severity?: "info" | "warning" | "error" | "critical";
	outcome?: "success" | "failure";
	correlationId?: string;
	ipAddress?: string;
} {
	return {
		from: filter.dateFrom ? filter.dateFrom.toISOString() : undefined,
		to: filter.dateTo ? filter.dateTo.toISOString() : undefined,
		action: filter.actions?.[0],
		category: filter.categories?.[0],
		severity: filter.severities?.[0],
		outcome: filter.outcomes?.[0],
		correlationId: filter.correlationId,
		ipAddress: filter.ipAddressContains,
	};
}

/**
 * Canonical 17-column CSV header — IDENTICAL to the in-product
 * `serializeAuditLogToCsv` (packages/api/modules/audit/lib/export-format.ts).
 * Keeping the column order + names in lock-step matters because downstream
 * tooling (SIEM connectors, awk scripts, the customer's own ELT pipeline)
 * scripts against the column order. The explorer is a staff-only surface
 * but operators routinely shuttle exports between it and the customer's
 * UI, so emitting the same schema lets them use one set of tools.
 */
const CSV_COLUMNS = [
	"timestamp",
	"actor_email",
	"actor_name",
	"actor_type",
	"action",
	"category",
	"severity",
	"outcome",
	"resource_type",
	"resource_id",
	"resource_name",
	"project_id",
	"ip_address",
	"user_agent",
	"request_id",
	"session_id",
	"impersonated_by_id",
] as const;

function csvEscape(value: unknown): string {
	if (value === null || value === undefined) {
		return "";
	}
	const str = typeof value === "string" ? value : JSON.stringify(value);
	if (/[",\r\n]/.test(str)) {
		return `"${str.replace(/"/g, '""')}"`;
	}
	return str;
}

/**
 * Flatten a `ProxyRow` (the API key proxy returns nested `actor` /
 * `resource` objects + folds `metadata.correlationId` / `requestId` into
 * a single `correlationId` top-level) into the field shape the
 * in-product NDJSON emits. Matches the AuditLogRow snake_case ↔ camelCase
 * naming convention from Prisma so the resulting line is indistinguishable
 * from a customer-side `audit.export` download.
 */
function flattenProxyRow(row: ProxyRow) {
	return {
		id: row.id,
		organizationId: row.organizationId,
		userId: row.userId,
		actorType: row.actorType,
		actorEmailSnapshot: row.actor?.email ?? null,
		actorNameSnapshot: row.actor?.name ?? null,
		impersonatedById: row.impersonatedById,
		action: row.action,
		category: row.category,
		severity: row.severity,
		outcome: row.outcome,
		resourceType: row.resource?.type ?? null,
		resourceId: row.resource?.id ?? null,
		resourceName: row.resource?.name ?? null,
		projectId: row.projectId,
		ipAddress: row.ipAddress,
		userAgent: row.userAgent,
		// The proxy collapses metadata.correlationId + requestId into a
		// single `correlationId` field. The in-product schema only has
		// `request_id` / `requestId`, so route the merged value there
		// — operators get the same correlation thread they'd get from
		// the customer's own REST endpoint.
		requestId: row.correlationId,
		sessionId: row.sessionId,
		metadata: row.metadata,
		durationMs: row.durationMs,
		createdAt: row.createdAt,
	};
}

/** @internal exported for parity test against the in-product serializer */
export function serializeRowsToCsv(rows: ProxyRow[]): string {
	const header = CSV_COLUMNS.join(",");
	const lines = rows.map((row) => {
		const flat = flattenProxyRow(row);
		return [
			csvEscape(flat.createdAt),
			csvEscape(flat.actorEmailSnapshot),
			csvEscape(flat.actorNameSnapshot),
			csvEscape(flat.actorType),
			csvEscape(flat.action),
			csvEscape(flat.category),
			csvEscape(flat.severity),
			csvEscape(flat.outcome),
			csvEscape(flat.resourceType),
			csvEscape(flat.resourceId),
			csvEscape(flat.resourceName),
			csvEscape(flat.projectId),
			csvEscape(flat.ipAddress),
			csvEscape(flat.userAgent),
			csvEscape(flat.requestId),
			csvEscape(flat.sessionId),
			csvEscape(flat.impersonatedById),
		].join(",");
	});
	// In-product uses `\n` line separator; match that.
	return [header, ...lines].join("\n").concat("\n");
}

/** @internal exported for parity test against the in-product serializer */
export function serializeRowsToNdjson(rows: ProxyRow[]): string {
	if (rows.length === 0) {
		return "";
	}
	return rows
		.map((row) => JSON.stringify(flattenProxyRow(row)))
		.join("\n")
		.concat("\n");
}

export function AuditLogExplorer() {
	const t = useTranslations("admin.auditLogExplorer");

	const [baseUrlHistory, setBaseUrlHistory] = useState<string[]>([]);
	const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL_DEV);
	const [apiKey, setApiKey] = useState("");
	const [showApiKey, setShowApiKey] = useState(false);

	const [connected, setConnected] = useState(false);
	const [connecting, setConnecting] = useState(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	const [tenant, setTenant] = useState<TenantInfo | null>(null);
	void tenant; // surfaced via `setTenant` for the connected pill; not read elsewhere

	// Filter + sort state lives at the explorer level — same shape the
	// in-product viewer uses, so we can pass it straight through to the
	// shared components.
	const [filters, setFilters] =
		useState<AuditLogFiltersState>(EMPTY_FILTERS_STATE);
	const [sort, setSort] = useState<AuditSortOrder>("newest");
	const [selectedRowId, setSelectedRowId] = useState<string | null>(null);

	// Observed rows feed the taxonomy override — the public REST surface
	// has no taxonomy endpoint, but rebuilding the action/category lists
	// from rows already on screen is good enough for the filter chips.
	const [observedRows, setObservedRows] = useState<{
		actions: Set<string>;
		categories: Set<string>;
	}>({ actions: new Set(), categories: new Set() });

	// Hydrate base-URL history + default on mount.
	useEffect(() => {
		const history = loadBaseUrlHistory();
		setBaseUrlHistory(history);
		setBaseUrl(pickDefaultBaseUrl(history));
	}, []);

	const showKeyAriaPressed = showApiKey;

	// Stable cache-key prefix for this connection. The base URL + the
	// (eventual) tenant identifier scopes the cache so switching keys or
	// hopping between local/staging/prod doesn't leak rows between caches.
	const tenantKey = tenant
		? `${tenant.kind}:${tenant.organizationId ?? tenant.userId ?? "?"}`
		: "pending";
	const cacheKey = useMemo(
		() => ["audit-log-explorer", tenantKey, baseUrl] as const,
		[tenantKey, baseUrl],
	);

	/**
	 * Adapter for `<AuditLogTable dataSource>`: pages the proxy procedure
	 * for the in-product viewer's filter/sort/cursor input and remaps the
	 * response rows to the shape the table renders.
	 */
	const tableDataSource: AuditLogTableDataSource = useMemo(
		() => ({
			cacheKey,
			list: async ({ filter, cursor, limit, sort: sortOrder }) => {
				// The proxy procedure accepts only `newest` / `oldest` sort
				// orders today; the viewer also offers `severity_desc`. Map
				// the third option to `newest` so the proxy doesn't reject
				// the call — the viewer's secondary visual indicators stay
				// usable even when the server-side ordering is identical.
				const proxySort: "newest" | "oldest" =
					sortOrder === "oldest" ? "oldest" : "newest";
				const response = await orpcClient.admin.auditLog.viaApiKey({
					apiKey,
					limit,
					cursor: cursor ?? undefined,
					sort: proxySort,
					...flattenFilterForProxy(filter),
				});
				const proxyItems =
					(response.items as unknown as ProxyRow[]) ?? [];
				const items = proxyItems.map(remapProxyRowToViewer);
				// Remember tenant info once we have it — drives the
				// `Connected to {baseUrl}` indicator.
				if (response.tenant && !tenant) {
					setTenant(response.tenant);
				}
				// Update the observed-taxonomy set so the filter chips have
				// options to surface.
				setObservedRows((prev) => {
					const nextActions = new Set(prev.actions);
					const nextCategories = new Set(prev.categories);
					for (const r of proxyItems) {
						if (r.action) {
							nextActions.add(r.action);
						}
						if (r.category) {
							nextCategories.add(r.category);
						}
					}
					if (
						nextActions.size === prev.actions.size &&
						nextCategories.size === prev.categories.size
					) {
						return prev;
					}
					return {
						actions: nextActions,
						categories: nextCategories,
					};
				});
				return {
					items: items as never,
					nextCursor: response.nextCursor,
					totalCount: response.total,
				};
			},
		}),
		[cacheKey, apiKey, tenant],
	);

	/**
	 * Adapter for `<AuditLogStatsStrip dataSource>`: routes the stats
	 * query through the staff proxy procedure so the customer's
	 * `aggregateAuditLogStats` runs against the tenant resolved from
	 * the API key.
	 */
	const statsDataSource: AuditLogStatsStripDataSource = useMemo(
		() => ({
			cacheKey,
			fetch: ({ latencyWindow }) =>
				orpcClient.admin.auditLog.statsViaApiKey({
					apiKey,
					latencyWindow,
				}),
		}),
		[cacheKey, apiKey],
	);

	/**
	 * Adapter for `<AuditLogExportButton dataSource>`: walks every page
	 * of the proxy procedure for the current filter set, capped at
	 * `EXPORT_ROW_CAP`, then serializes to CSV/NDJSON. Returns the body
	 * + filename + content-type contract the export button expects so it
	 * can trigger the Blob download itself.
	 */
	const exportDataSource: AuditLogExportDataSource = useMemo(
		() => ({
			export: async ({ format, filter }) => {
				const collected: ProxyRow[] = [];
				let cursor: string | null = null;
				const proxyFilter = flattenFilterForProxy(filter);
				while (collected.length < EXPORT_ROW_CAP) {
					const remaining = EXPORT_ROW_CAP - collected.length;
					const response = await orpcClient.admin.auditLog.viaApiKey({
						apiKey,
						limit: Math.min(EXPORT_PAGE_SIZE, remaining),
						cursor: cursor ?? undefined,
						sort: "newest",
						...proxyFilter,
					});
					const batch =
						(response.items as unknown as ProxyRow[]) ?? [];
					collected.push(...batch);
					if (!response.nextCursor || batch.length === 0) {
						break;
					}
					cursor = response.nextCursor;
				}
				const body =
					format === "csv"
						? serializeRowsToCsv(collected)
						: serializeRowsToNdjson(collected);
				const filename = `audit-log-${new Date()
					.toISOString()
					.slice(0, 10)}.${format}`;
				const contentType =
					format === "csv"
						? "text/csv;charset=utf-8"
						: "application/x-ndjson;charset=utf-8";
				return { body, filename, contentType };
			},
		}),
		[apiKey],
	);

	async function connect() {
		setErrorMessage(null);
		setConnecting(true);
		try {
			// Probe call to verify the key + capture tenant metadata. The
			// filter/sort/cursor state stays in the React-Query cache via
			// the table's data source — we just need the tenant info now.
			const response = await orpcClient.admin.auditLog.viaApiKey({
				apiKey,
				limit: 50,
				sort: "newest",
			});
			setTenant(response.tenant);
			setConnected(true);

			// Persist the base URL into the combobox history (most recent
			// first). The api key is NEVER persisted.
			if (baseUrl && isHttpUrl(baseUrl)) {
				const dedup = [
					baseUrl,
					...baseUrlHistory.filter((u) => u !== baseUrl),
				].slice(0, BASE_URL_HISTORY_MAX);
				setBaseUrlHistory(dedup);
				persistBaseUrlHistory(dedup);
			}
		} catch (err) {
			const msg =
				err instanceof Error
					? err.message
					: String(err) || "Unknown error";
			// Surface a friendly error and keep the connect form mounted.
			if (msg.toLowerCase().includes("unauthorized")) {
				setErrorMessage(t("errors.invalidKey"));
			} else if (msg.toLowerCase().includes("not_found")) {
				setErrorMessage(t("errors.notFound"));
			} else {
				setErrorMessage(t("errors.genericFetch", { message: msg }));
			}
			setConnected(false);
		} finally {
			setConnecting(false);
		}
	}

	function disconnect() {
		setConnected(false);
		setTenant(null);
		setApiKey(""); // Clear the secret from memory.
		setFilters(EMPTY_FILTERS_STATE);
		setSelectedRowId(null);
		setObservedRows({ actions: new Set(), categories: new Set() });
	}

	const docsHref = useMemo(() => {
		if (!baseUrl || !isHttpUrl(baseUrl)) {
			return null;
		}
		return new URL("/api/v1/docs", baseUrl).toString();
	}, [baseUrl]);

	const taxonomyOverride = useMemo(
		() => ({
			actions: Array.from(observedRows.actions).sort(),
			categories: Array.from(observedRows.categories).sort(),
		}),
		[observedRows],
	);

	return (
		// `min-w-0` lets the flex item shrink below content width so the
		// shared viewer table's overflow-x:auto kicks in instead of
		// pushing the parent past the viewport edge — matches the
		// in-product viewer's outer container constraint.
		<div className="flex min-w-0 flex-col gap-8 pb-10">
			{/* ============ Hero (title + subtitle + explanation in one block) ============ */}
			<header className="relative overflow-hidden rounded-xl border border-border/60 bg-card px-6 py-8 sm:px-8 sm:py-10">
				<div
					className="pointer-events-none absolute inset-0 text-foreground/10 app-dot-grid"
					aria-hidden="true"
				/>
				<div className="relative space-y-4">
					<p className="app-editorial-label">{t("label")}</p>
					<div className="flex flex-wrap items-center justify-between gap-3">
						<h1 className="font-serif text-3xl font-normal tracking-tight text-foreground/95 sm:text-4xl">
							{t("title")}
						</h1>
						{docsHref ? (
							<Button asChild variant="outline" size="sm">
								<a
									href={docsHref}
									target="_blank"
									rel="noopener noreferrer"
									aria-label={t("docsLink")}
								>
									<BookOpenTextIcon
										aria-hidden="true"
										className="mr-2 size-4"
									/>
									{t("docsLink")}
								</a>
							</Button>
						) : null}
					</div>
					<p className="max-w-3xl text-sm leading-6 text-muted-foreground sm:text-base">
						{t("subtitle")}
					</p>
					<p className="max-w-4xl text-sm leading-6 text-muted-foreground/90">
						{t("explanation")}
					</p>
				</div>
			</header>

			{/* ============ Connect card ============ */}
			<section aria-labelledby="connect-heading">
				<Card className="space-y-5 p-6">
					<header className="flex flex-wrap items-start justify-between gap-3">
						<div className="flex flex-col gap-1.5">
							<p className="app-editorial-label">
								{connected
									? t("connect.connectedLabel")
									: t("connect.label")}
							</p>
							<h2
								id="connect-heading"
								className="font-serif text-xl font-normal text-foreground"
							>
								{t("connect.title")}
							</h2>
						</div>
						{connected ? (
							<div className="flex items-center gap-2 rounded-full border border-secondary/30 bg-secondary/10 px-3 py-1.5 text-xs text-secondary">
								<PlugZapIcon
									aria-hidden="true"
									className="size-3.5"
								/>
								<span data-testid="explorer-tenant-summary">
									<code className="font-mono text-secondary">
										{baseUrl}
									</code>
								</span>
							</div>
						) : null}
					</header>

					<div className="grid gap-4 sm:grid-cols-2">
						<div className="space-y-1.5">
							<Label htmlFor="audit-explorer-base-url">
								{t("connect.baseUrl")}
							</Label>
							<Input
								id="audit-explorer-base-url"
								name="base-url"
								type="url"
								list="audit-explorer-base-url-history"
								placeholder={t("connect.baseUrlPlaceholder")}
								value={baseUrl}
								onChange={(e) => setBaseUrl(e.target.value)}
								autoComplete="off"
								className="font-mono text-sm"
							/>
							<datalist id="audit-explorer-base-url-history">
								{baseUrlHistory.map((u) => (
									<option key={u} value={u} />
								))}
							</datalist>
							<p className="text-xs leading-5 text-muted-foreground">
								{t("connect.baseUrlHelp")}
							</p>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="audit-explorer-api-key">
								{t("connect.apiKey")}
							</Label>
							<div className="relative">
								<Input
									id="audit-explorer-api-key"
									name="api-key"
									type={showApiKey ? "text" : "password"}
									placeholder={t("connect.apiKeyPlaceholder")}
									value={apiKey}
									onChange={(e) => setApiKey(e.target.value)}
									onKeyDown={(e) => {
										if (
											e.key === "Enter" &&
											!connecting &&
											apiKey.trim().length > 0
										) {
											e.preventDefault();
											void connect();
										}
									}}
									autoComplete="off"
									data-testid="explorer-api-key-input"
									className="pr-10 font-mono text-sm"
								/>
								<button
									type="button"
									onClick={() => setShowApiKey((v) => !v)}
									aria-pressed={showKeyAriaPressed}
									aria-label={
										showApiKey
											? t("connect.hideKey")
											: t("connect.showKey")
									}
									className="absolute inset-y-0 right-0 flex items-center px-2 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								>
									{showApiKey ? (
										<EyeOffIcon
											aria-hidden="true"
											className="size-4"
										/>
									) : (
										<EyeIcon
											aria-hidden="true"
											className="size-4"
										/>
									)}
								</button>
							</div>
							<p className="text-xs leading-5 text-muted-foreground">
								{t("connect.apiKeyHelp")}
							</p>
						</div>
					</div>
					<div className="flex justify-end gap-2 pt-1">
						{!connected ? (
							<Button
								type="button"
								onClick={() => void connect()}
								disabled={
									connecting || apiKey.trim().length === 0
								}
								data-testid="explorer-connect-button"
							>
								{connecting ? (
									<>
										<Loader2Icon
											aria-hidden="true"
											className="mr-2 size-4 animate-spin"
										/>
										{t("pagination.loading")}
									</>
								) : (
									<>
										<PlugIcon
											aria-hidden="true"
											className="mr-2 size-4"
										/>
										{t("connect.connectButton")}
									</>
								)}
							</Button>
						) : (
							<Button
								type="button"
								variant="outline"
								onClick={disconnect}
								data-testid="explorer-disconnect-button"
							>
								{t("connect.disconnect")}
							</Button>
						)}
					</div>

					{errorMessage ? (
						<div
							role="status"
							aria-live="polite"
							className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
							data-testid="explorer-error"
						>
							<AlertCircleIcon
								aria-hidden="true"
								className="mt-0.5 size-4 shrink-0"
							/>
							<span className="leading-5">{errorMessage}</span>
						</div>
					) : null}
				</Card>
			</section>

			{/* ============ Filters + Table — shared viewer components ============ */}
			{connected ? (
				<section
					aria-labelledby="explorer-results-heading"
					data-testid="explorer-results-section"
					className="flex min-w-0 flex-col gap-4"
				>
					<div
						className="inline-flex w-fit items-center gap-2 rounded-full border border-secondary/40 bg-card px-3 py-1.5 text-xs"
						data-testid="explorer-connected-url"
					>
						<PlugZapIcon
							aria-hidden="true"
							className="size-3.5 text-secondary"
						/>
						<span className="uppercase tracking-wider text-muted-foreground">
							Connected to
						</span>
						<code className="font-mono text-foreground">
							{baseUrl}
						</code>
					</div>

					<h2 id="explorer-results-heading" className="sr-only">
						{t("filters.title")}
					</h2>

					<AuditLogStatsStrip
						organizationId={null}
						dataSource={statsDataSource}
					/>

					<div className="flex flex-col gap-3">
						<AuditLogFilters
							mode="explorer"
							organizationId={null}
							filters={filters}
							onFiltersChange={setFilters}
							currentUser={null}
							taxonomy={taxonomyOverride}
						/>
						<div className="flex flex-wrap items-center justify-between gap-2">
							<AuditLogActivePills
								mode="explorer"
								filters={filters}
								currentUser={null}
								onFiltersChange={setFilters}
							/>
							<div className="ml-auto flex flex-wrap items-center justify-end gap-2">
								<AuditLogSortControl
									value={sort}
									onChange={setSort}
								/>
								<AuditLogExportButton
									organizationId={null}
									filters={filters}
									dataSource={exportDataSource}
								/>
							</div>
						</div>
					</div>

					<AuditLogTable
						mode="explorer"
						organizationId={null}
						filters={filters}
						viewerTimezone="UTC"
						onRowSelect={setSelectedRowId}
						onCorrelationClick={(id) =>
							setFilters((prev) => ({
								...prev,
								correlationId: id,
							}))
						}
						sort={sort}
						dataSource={tableDataSource}
					/>

					<AuditLogMetadataDrawer
						organizationId={null}
						filters={filters}
						selectedRowId={selectedRowId}
						viewerTimezone="UTC"
						onClose={() => setSelectedRowId(null)}
						// Trace flow is hidden in explorer mode — the trace
						// endpoint reads in-process spans which the public
						// REST surface cannot reach.
						onTraceCorrelation={undefined}
						cacheKeyPrefix={cacheKey}
					/>
				</section>
			) : null}
		</div>
	);
}
