/**
 * ProviderHealthBadge Component
 *
 * Renders one of the six `ProviderHealthStatus` values as a small badge
 * with icon, label, and accessibility-first metadata. Sits in the
 * `ConnectionCard` header cluster next to the existing `SyncStatusBadge`,
 * which describes per-tenant sync state. These two concepts are
 * intentionally DISTINCT:
 *
 *   - `SyncStatusBadge` (rounded `Badge`)     -- tenant-scoped sync state
 *     (PENDING / CONNECTED / SYNCING / ERROR / PAUSED / EXPIRED).
 *   - `ProviderHealthBadge` (rounded `Badge`, dot-leading) -- upstream
 *     provider availability (OPERATIONAL / DEGRADED / PARTIAL_OUTAGE /
 *     MAJOR_OUTAGE / MAINTENANCE / UNKNOWN). NOT per-tenant.
 *
 * Visual language (CLAUDE.md aesthetic constraints)
 * ------------------------------------------------
 * - Uses semantic CSS tokens (`--secondary` emerald, `--highlight` amber,
 *   `--destructive` red, `--primary` for blue/maintenance, `--muted` for
 *   unknown). NO hardcoded hex.
 * - Leading colored dot (4px filled circle) to disambiguate from the
 *   rectangular sync-status badge at a glance.
 * - No glassmorphism, no animated gradient, no `transition-all`. Color
 *   transitions are scoped to `colors` only.
 *
 * Accessibility (WCAG 2.1 AA)
 * ----------------------------
 * - `role="status"` on the rendered element so SR users hear status changes.
 * - Distinct `aria-label` per status, prefixed with the provider name so
 *   the listener can disambiguate when many badges are stacked.
 * - When `onClickOpenDrawer` is provided, the badge becomes a button with
 *   a tooltip wrapper -- keyboard reachable, Enter / Space activates it,
 *   tooltip is announced on focus via the shadcn `<Tooltip>` primitive.
 * - When NOT clickable, the badge renders as a plain span so it does not
 *   show up in the keyboard tab order.
 */

"use client";

import { Badge } from "@ui/components/badge";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import {
	Activity,
	AlertCircle,
	AlertTriangle,
	CheckCircle,
	ExternalLink,
	HelpCircle,
	MinusCircle,
	Wrench,
} from "lucide-react";

export type ProviderHealthStatusValue =
	| "OPERATIONAL"
	| "DEGRADED"
	| "PARTIAL_OUTAGE"
	| "MAJOR_OUTAGE"
	| "MAINTENANCE"
	| "UNKNOWN"
	| "NOT_CONFIGURED";

export interface ProviderHealthBadgeProps {
	status: ProviderHealthStatusValue;
	providerName: string;
	/**
	 * Short summary of the currently active incident, when any. Renders
	 * inside the tooltip body. The procedure caps this server-side so we
	 * do not truncate again here.
	 */
	incidentSummary?: string | null;
	/** ISO date / Date when the active incident started. Optional. */
	startedAt?: Date | string | null;
	/** Provider statuspage URL. Optional; not all providers publish one. */
	statusPageUrl?: string | null;
	/**
	 * When provided, the badge becomes a button that opens the incident
	 * drawer. When omitted, the badge is a non-interactive span (used when
	 * the host card has its own click target -- avoids nested buttons).
	 */
	onClickOpenDrawer?: () => void;
	/**
	 * Visual scale.
	 *
	 *   - `"default"` — small 5-row card label (listing surfaces).
	 *   - `"lg"`      — prominent badge with a larger dot and 12px label,
	 *                   designed to sit next to a provider name on a
	 *                   detail-page hero.
	 */
	size?: "default" | "lg";
	className?: string;
}

interface HealthVisualConfig {
	label: string;
	Icon: typeof CheckCircle;
	/** Tailwind classes applied to the badge surface. */
	surfaceClass: string;
	/** Tailwind class applied to the leading dot (filled circle). */
	dotClass: string;
	/** Human-readable description used in `aria-label`. */
	ariaText: string;
}

/**
 * The six visual configurations. Every color reference here is a
 * design-token utility class (`text-secondary`, `bg-highlight/10`, ...)
 * mapped through Tailwind to the CSS variables in `globals.css`. No
 * hardcoded hex per CLAUDE.md.
 */
const HEALTH_CONFIG: Record<ProviderHealthStatusValue, HealthVisualConfig> = {
	OPERATIONAL: {
		label: "Operational",
		Icon: CheckCircle,
		surfaceClass:
			"border-secondary/30 bg-secondary/10 text-secondary dark:text-secondary",
		dotClass: "bg-secondary",
		ariaText: "operational",
	},
	DEGRADED: {
		label: "Degraded",
		Icon: Activity,
		surfaceClass:
			"border-highlight/30 bg-highlight/10 text-highlight dark:text-highlight",
		dotClass: "bg-highlight",
		ariaText: "degraded",
	},
	PARTIAL_OUTAGE: {
		label: "Partial outage",
		Icon: AlertTriangle,
		// Orange/destructive blend: we want orange between amber and
		// destructive. We reuse `--destructive` with reduced opacity to keep
		// the token surface (no hardcoded hex per CLAUDE.md). The icon and
		// label stay legible against the tint.
		surfaceClass:
			"border-destructive/30 bg-destructive/10 text-destructive dark:text-destructive",
		dotClass: "bg-destructive",
		ariaText: "partial outage",
	},
	MAJOR_OUTAGE: {
		label: "Major outage",
		Icon: AlertCircle,
		surfaceClass:
			"border-destructive/50 bg-destructive/15 text-destructive dark:text-destructive",
		dotClass: "bg-destructive",
		ariaText: "major outage",
	},
	MAINTENANCE: {
		label: "Maintenance",
		Icon: Wrench,
		surfaceClass:
			"border-primary/30 bg-primary/10 text-primary dark:text-primary",
		dotClass: "bg-primary",
		ariaText: "in scheduled maintenance",
	},
	UNKNOWN: {
		label: "Status unavailable",
		Icon: HelpCircle,
		surfaceClass:
			"border-border bg-muted text-muted-foreground dark:text-muted-foreground",
		dotClass: "bg-muted-foreground/60",
		ariaText: "status unavailable",
	},
	NOT_CONFIGURED: {
		label: "Not configured",
		Icon: MinusCircle,
		// The synthetic probe is registered but cannot run because the
		// required env vars are missing in this environment. The provider
		// itself is not necessarily down — render a neutral gray badge
		// (distinct from MAJOR_OUTAGE) to signal "we can't tell from here",
		// NOT a red outage.
		surfaceClass:
			"border-border bg-muted text-muted-foreground dark:text-muted-foreground",
		dotClass: "bg-muted-foreground/60",
		ariaText: "synthetic probe not configured in this environment",
	},
};

/**
 * Public testing surface — exposed so unit tests can iterate every status
 * value without hardcoding the literal union in the test file.
 */
export const PROVIDER_HEALTH_STATUS_VALUES: readonly ProviderHealthStatusValue[] =
	[
		"OPERATIONAL",
		"DEGRADED",
		"PARTIAL_OUTAGE",
		"MAJOR_OUTAGE",
		"MAINTENANCE",
		"UNKNOWN",
		"NOT_CONFIGURED",
	];

export function ProviderHealthBadge({
	status,
	providerName,
	incidentSummary,
	startedAt,
	statusPageUrl,
	onClickOpenDrawer,
	size = "default",
	className,
}: ProviderHealthBadgeProps) {
	const config = HEALTH_CONFIG[status];
	const Icon = config.Icon;
	const ariaLabel = `${providerName} status: ${config.ariaText}`;
	const isLarge = size === "lg";

	const badgeBody = (
		<Badge
			variant="outline"
			className={cn(
				"flex items-center transition-colors duration-150",
				// Larger surface on the provider-detail hero so the status
				// circle reads clearly next to a 2xl provider name. Default
				// size stays compact for listing cards.
				isLarge ? "gap-2 px-2.5 py-1" : "gap-1.5 px-2 py-0.5",
				config.surfaceClass,
				className,
			)}
		>
			<span
				aria-hidden="true"
				className={cn(
					"rounded-full shrink-0",
					isLarge ? "h-2.5 w-2.5" : "h-1.5 w-1.5",
					config.dotClass,
				)}
			/>
			<Icon
				className={cn("shrink-0", isLarge ? "h-3.5 w-3.5" : "h-3 w-3")}
				aria-hidden="true"
			/>
			<span
				className={cn(
					"font-medium",
					isLarge ? "text-xs" : "text-[11px]",
				)}
			>
				{config.label}
			</span>
		</Badge>
	);

	const startedAtDate =
		startedAt instanceof Date
			? startedAt
			: typeof startedAt === "string" && startedAt.length > 0
				? new Date(startedAt)
				: null;

	const tooltipContent = (
		<TooltipContent className="max-w-xs">
			<p className="font-medium text-sm">{providerName}</p>
			<p className="mt-0.5 text-xs text-muted-foreground">
				{config.label}
			</p>
			{status === "NOT_CONFIGURED" ? (
				<p className="mt-1.5 text-xs text-foreground">
					Synthetic probe disabled because the required environment
					variable is missing in this environment. The provider itself
					is not necessarily down — check the provider's status page
					directly.
				</p>
			) : incidentSummary ? (
				<p className="mt-1.5 text-xs text-foreground">
					{incidentSummary}
				</p>
			) : null}
			{startedAtDate && !Number.isNaN(startedAtDate.getTime()) ? (
				<p className="mt-1 text-[11px] text-muted-foreground">
					Started{" "}
					{formatDistanceToNow(startedAtDate, { addSuffix: true })}
				</p>
			) : null}
			{statusPageUrl ? (
				<a
					href={statusPageUrl}
					target="_blank"
					rel="noopener noreferrer"
					className="mt-2 inline-flex items-center gap-1 text-[11px] underline underline-offset-2 text-primary hover:text-primary/80"
					// Prevent the badge click handler from firing when the
					// user activates the link inside the tooltip.
					onClick={(event) => event.stopPropagation()}
				>
					View status page
					<ExternalLink className="h-3 w-3" />
				</a>
			) : null}
		</TooltipContent>
	);

	// Interactive variant -- becomes a button so keyboard users can
	// activate the drawer with Enter / Space. The button is the
	// interactive trigger; the inner `<span role="status">` carries the
	// live-region semantics so screen readers announce health changes
	// without breaking the implicit button role.
	if (onClickOpenDrawer) {
		return (
			<TooltipProvider delayDuration={150}>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							aria-label={ariaLabel}
							onClick={onClickOpenDrawer}
							className="appearance-none rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
						>
							<span role="status" className="contents">
								{badgeBody}
							</span>
						</button>
					</TooltipTrigger>
					{tooltipContent}
				</Tooltip>
			</TooltipProvider>
		);
	}

	// Static variant -- no click handler, no button (avoids nested
	// interactive descendants when the parent card is itself a link).
	// The `<span role="status">` is a non-interactive live region; the
	// `<TooltipTrigger asChild>` handles focusability via Radix.
	return (
		<TooltipProvider delayDuration={150}>
			<Tooltip>
				<TooltipTrigger asChild>
					<span role="status" aria-label={ariaLabel}>
						{badgeBody}
					</span>
				</TooltipTrigger>
				{tooltipContent}
			</Tooltip>
		</TooltipProvider>
	);
}
