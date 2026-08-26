"use client";

/**
 * Shared incident-surface logic.
 *
 * The active-incident signal is rendered in two places (see the placement
 * pass that moved it off the fixed top-right chip):
 *   1. `IncidentChip`          — an inline chip in the dashboard hero, docked
 *      to the left of the "Last 90 days" range picker. Static (scrolls with
 *      the page), Start-page only.
 *   2. `IncidentRailIndicator` — a small triangle in the sidebar footer, next
 *      to the notification bell. Visible on every page (the rail is global),
 *      and survives the 72px collapsed rail used in settings / fullscreen.
 *
 * Both surfaces share: the feature-flag + role gate, the 60s poll (deduped by
 * a single React-Query key so two mounts never double-fetch), the severity
 * normalization, the colour tokens, and the tooltip body. This module is the
 * single source of truth for all of that; the two components are thin
 * presentational shells over `useIncidentSummary()`.
 */

import { useSession } from "@saas/auth/hooks/use-session";
import { useActiveOrganization } from "@saas/organizations/hooks/use-active-organization";
import { useMonitoringFeatureFlag } from "@saas/shared/lib/use-monitoring-feature-flag";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@ui/lib";
import { useRouter } from "next/navigation";
import { useCallback } from "react";

/** Refresh cadence — same 60s window the original banner/chip used. */
const REFETCH_INTERVAL_MS = 60_000;

/** Maximum incidents enumerated in the tooltip body before we truncate. */
const TOOLTIP_LIST_CAP = 3;

/**
 * Monitoring dashboard sub-path. Both surfaces append this to the *active
 * workspace* base path on click so the destination keeps the current org slug
 * (e.g. `/app/{slug}/admin/monitoring`) and the workspace selector does not flip
 * to "Personal". In personal context the base path is `/app`, which yields the
 * canonical `MONITORING_DASHBOARD_PATH` below. The monitoring data itself is
 * platform-wide (system-admin signal) regardless of the slug.
 */
const MONITORING_DASHBOARD_SUBPATH = "/admin/monitoring";

/**
 * Decide whether the current viewer is allowed to see the incident surface.
 *
 * As of the v3 admin-incidents pass, this is system-admins-only. The chip and
 * rail communicate platform-wide / cross-tenant signals (Fabric subsystem
 * outages, error-budget burn across all customers, third-party provider
 * incidents that admins triage). Org owners do not have the context or
 * permissions to act on these signals from the customer dashboard. Their
 * per-org integration health is still surfaced via the per-org incident
 * banner inside `/app/{slug}/settings/integrations` and via INTEGRATION_
 * INCIDENT Notifications — those are about the customer's OWN integrations.
 *
 * The second argument is retained in the signature for compatibility with
 * existing callers but is not consulted. Tests can pass `null` for it.
 */
export function canViewIncidentChip(
	userRole: string | null | undefined,
	_activeOrgRole: string | null | undefined,
): boolean {
	return userRole === "admin";
}

/** Severity strings emitted by the server-side enum mapping. */
type IncidentSeverity = "SEV1" | "SEV2" | "SEV3";

interface ErrorRateIncidentRow {
	id: string;
	severity: IncidentSeverity;
	service: string;
	feature: string;
	status: string;
}

interface IntegrationIncidentRow {
	id: string;
	severity: IncidentSeverity;
	providerKey: string;
	providerName: string;
	status: string;
	summary?: string | null;
}

interface ComponentIncidentRow {
	id: string;
	severity: IncidentSeverity;
	componentKey: string;
	componentName: string;
	status: string;
	summary?: string | null;
}

interface ActiveIncidentsResponse {
	errorRate: ErrorRateIncidentRow[];
	integration: IntegrationIncidentRow[];
	component?: ComponentIncidentRow[];
}

export interface NormalizedIncident {
	id: string;
	severity: IncidentSeverity;
	title: string;
}

/**
 * Flatten the multi-stream payload into a single uniformly-shaped array,
 * sorted by severity (SEV-1 first) so the colour and tooltip both lead with
 * the most urgent rows.
 */
function normalize(payload: ActiveIncidentsResponse | undefined): {
	all: NormalizedIncident[];
	sev1Count: number;
	sev2Count: number;
	sev3Count: number;
} {
	const errorRate: NormalizedIncident[] = (payload?.errorRate ?? []).map(
		(row) => ({
			id: row.id,
			severity: row.severity,
			title: `${row.service} / ${row.feature}`,
		}),
	);
	const integration: NormalizedIncident[] = (payload?.integration ?? []).map(
		(row) => {
			const summary = row.summary?.trim();
			return {
				id: row.id,
				severity: row.severity,
				title:
					summary && summary.length > 0
						? `${row.providerName}: ${summary}`
						: row.providerName,
			};
		},
	);
	// v3 admin-incidents pass: Fabric subsystem outages also fan into the
	// normalized stream. The `component` field is optional on the response
	// shape to stay forward-compatible with API responses that predate v3.
	const component: NormalizedIncident[] = (payload?.component ?? []).map(
		(row) => {
			const summary = row.summary?.trim();
			return {
				id: row.id,
				severity: row.severity,
				title:
					summary && summary.length > 0
						? `${row.componentName}: ${summary}`
						: row.componentName,
			};
		},
	);

	const all = [...errorRate, ...integration, ...component];
	const severityRank: Record<IncidentSeverity, number> = {
		SEV1: 0,
		SEV2: 1,
		SEV3: 2,
	};
	all.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

	let sev1Count = 0;
	let sev2Count = 0;
	let sev3Count = 0;
	for (const item of all) {
		if (item.severity === "SEV1") {
			sev1Count += 1;
		} else if (item.severity === "SEV2") {
			sev2Count += 1;
		} else {
			sev3Count += 1;
		}
	}

	return { all, sev1Count, sev2Count, sev3Count };
}

type ChipTone = "destructive" | "warning";

interface ChipPaint {
	tone: ChipTone;
	/** Solid-card chip treatment (used by the dashboard chip). */
	chipClass: string;
	/** Icon colour token (shared by chip + rail triangle). */
	iconClass: string;
	/** Severity dot colour token. */
	dotClass: string;
}

/**
 * Translate the highest active severity into the surface's colour tokens.
 * SEV-1 wins over SEV-2; SEV-3 alone is not rendered (the consumer short-
 * circuits on `shouldRender` before this matters).
 */
function paintFor(sev1Count: number): ChipPaint {
	// Chip uses a solid card background with a coloured border + icon, matching
	// the dashboard's outline controls. A 10% tint reads as transparent on the
	// stone-toned hero background.
	if (sev1Count > 0) {
		return {
			tone: "destructive",
			chipClass:
				"border-destructive/40 bg-card text-destructive shadow-sm hover:bg-destructive/5",
			iconClass: "text-destructive",
			dotClass: "bg-destructive",
		};
	}
	return {
		tone: "warning",
		chipClass:
			"border-highlight/50 bg-card text-highlight shadow-sm hover:bg-highlight/5",
		iconClass: "text-highlight",
		dotClass: "bg-highlight",
	};
}

/**
 * Human label for the surface's `aria-label` and tooltip header. Reads as a
 * single short phrase: "1 SEV-1 incident, 2 SEV-2 incidents".
 */
function severityBreakdownLabel(sev1Count: number, sev2Count: number): string {
	const parts: string[] = [];
	if (sev1Count > 0) {
		parts.push(
			sev1Count === 1
				? `${sev1Count} SEV-1 incident`
				: `${sev1Count} SEV-1 incidents`,
		);
	}
	if (sev2Count > 0) {
		parts.push(
			sev2Count === 1
				? `${sev2Count} SEV-2 incident`
				: `${sev2Count} SEV-2 incidents`,
		);
	}
	return parts.join(", ");
}

export interface IncidentSummary {
	/**
	 * True only when the feature is enabled, the viewer may see the surface,
	 * and at least one SEV-1/SEV-2 incident is active. Consumers return `null`
	 * when this is false so they contribute no pixels.
	 */
	shouldRender: boolean;
	tone: ChipTone;
	paint: ChipPaint;
	/** SEV-1 + SEV-2 count (SEV-3 is excluded — surfaced in the dashboard). */
	visibleCount: number;
	sev1Count: number;
	sev2Count: number;
	sev3Count: number;
	/** "1 SEV-1 incident, 2 SEV-2 incidents" */
	heading: string;
	/** Up to TOOLTIP_LIST_CAP rows (SEV-1/SEV-2 only), highest severity first. */
	enumeratedRows: NormalizedIncident[];
	overflowCount: number;
	navigateToMonitoring: () => void;
}

/**
 * Single source of truth for the incident surfaces. Calls all hooks
 * unconditionally; the React-Query key is shared so the chip and the rail
 * indicator co-mounted on the dashboard share one cache entry / one poll.
 */
export function useIncidentSummary(): IncidentSummary {
	const featureEnabled = useMonitoringFeatureFlag("feature-incident-banner");
	const { user } = useSession();
	const { activeOrganization, activeOrganizationUserRole } =
		useActiveOrganization();
	const router = useRouter();
	// Keep the user in their current workspace: navigate within the active base
	// path (`/app/{slug}` in org context, `/app` in personal) so the URL retains
	// the org slug and the workspace selector stays on the org instead of
	// flipping to "Personal". Derived from the same `useActiveOrganization()`
	// call the workspace selector reads from (rather than pulling in a second
	// `use-organization-context` hook), so this surface stays decoupled.
	const basePath = activeOrganization?.slug
		? `/app/${activeOrganization.slug}`
		: "/app";

	const canView = canViewIncidentChip(user?.role, activeOrganizationUserRole);

	const { data } = useQuery<ActiveIncidentsResponse>({
		queryKey: ["integrationHealth", "listActiveIncidents", "chip"],
		queryFn: () =>
			orpcClient.integrationHealth.listActiveIncidents(
				{},
			) as Promise<ActiveIncidentsResponse>,
		refetchInterval: REFETCH_INTERVAL_MS,
		// Skip the query when neither surface can render anyway — saves a poll
		// every 60s for every regular member / personal-only user.
		enabled: featureEnabled && canView,
		refetchOnWindowFocus: false,
	});

	const navigateToMonitoring = useCallback(() => {
		router.push(`${basePath}${MONITORING_DASHBOARD_SUBPATH}`);
	}, [router, basePath]);

	const { all, sev1Count, sev2Count, sev3Count } = normalize(data);

	// SEV-1 + SEV-2 drive the surface. SEV-3-only incidents are surfaced via
	// the weekly digest and the admin dashboard timeline; rendering them in an
	// always-visible surface would generate ambient noise.
	const visibleCount = sev1Count + sev2Count;
	const tone: ChipTone = sev1Count > 0 ? "destructive" : "warning";
	const paint = paintFor(sev1Count);
	const heading = severityBreakdownLabel(sev1Count, sev2Count);

	const visibleRows = all.filter(
		(row) => row.severity === "SEV1" || row.severity === "SEV2",
	);
	const enumeratedRows = visibleRows.slice(0, TOOLTIP_LIST_CAP);
	const overflowCount = Math.max(0, visibleRows.length - TOOLTIP_LIST_CAP);

	return {
		shouldRender: featureEnabled && canView && visibleCount > 0,
		tone,
		paint,
		visibleCount,
		sev1Count,
		sev2Count,
		sev3Count,
		heading,
		enumeratedRows,
		overflowCount,
		navigateToMonitoring,
	};
}

/**
 * Shared tooltip inner content for both the chip and the rail indicator.
 * Rendered inside each surface's own `<TooltipContent>` so the wrapper styling
 * (max-width, padding) stays with the trigger. The colour tokens assume the
 * dark (foreground-coloured) tooltip surface — hence `text-background/*`.
 */
export function IncidentTooltipBody({
	enumeratedRows,
	overflowCount,
	sev3Count,
}: {
	enumeratedRows: NormalizedIncident[];
	overflowCount: number;
	sev3Count: number;
}) {
	return (
		<>
			<p className="font-semibold tracking-wide">Active incidents</p>
			<ul className="space-y-1">
				{enumeratedRows.map((row) => (
					<li key={row.id} className="flex items-start gap-2">
						<span
							className={cn(
								"mt-1 inline-block size-1.5 shrink-0 rounded-full",
								row.severity === "SEV1"
									? "bg-destructive"
									: "bg-highlight",
							)}
							aria-hidden="true"
						/>
						<span className="min-w-0 flex-1">
							<span className="font-medium">
								{row.severity.replace("SEV", "SEV-")}
							</span>
							<span className="text-background/80">{" — "}</span>
							<span className="break-words">{row.title}</span>
						</span>
					</li>
				))}
				{overflowCount > 0 ? (
					<li className="pl-3.5 text-background/70">
						{`+ ${overflowCount} more`}
					</li>
				) : null}
			</ul>
			{sev3Count > 0 ? (
				<p className="text-background/60">
					{sev3Count === 1
						? "1 SEV-3 incident is open in the dashboard."
						: `${sev3Count} SEV-3 incidents are open in the dashboard.`}
				</p>
			) : null}
			<p className="text-background/70">
				Click to view monitoring dashboard.
			</p>
		</>
	);
}
