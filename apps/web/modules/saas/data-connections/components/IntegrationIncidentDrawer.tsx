/**
 * IntegrationIncidentDrawer Component
 *
 * A right-side `Sheet` (drawer) that surfaces the 30-day incident timeline
 * for a single integration provider. Opens from `ProviderHealthBadge` click
 * or a "View incidents" affordance on the ConnectionCard.
 *
 * Data
 * ----
 * - Fetches via `orpcClient.integrationHealth.getProviderIncidents` with a
 *   30-day window. Query is `enabled` only when the drawer is open, so
 *   we do not pay the round-trip until the user expresses intent.
 * - Each incident row carries severity, started / resolved timestamps,
 *   summary, affected components, and a link to the upstream statuspage
 *   when available.
 *
 * Visual language
 * ---------------
 * - Editorial: thin colored bar prefix on each row to encode severity.
 * - SEV-1 -> `--destructive`. SEV-2 -> `--highlight`. SEV-3 -> `--muted`.
 * - No glassmorphism, no animated gradient. Shadcn `<Sheet>` already
 *   focus-traps so we inherit AA-grade keyboard handling.
 *
 * States
 * ------
 * - Loading: three skeleton rows (NOT a spinner) so layout is stable.
 * - Empty: editorial empty-state copy plus a sentence pointing at the
 *   statuspage link, mirroring the existing empty-state aesthetic.
 * - Error: a single tinted block. Same tone as the SEV-2 banner.
 */

"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import { cn } from "@ui/lib";
import { format, formatDistanceToNow } from "date-fns";
import { ExternalLink, History } from "lucide-react";

export interface IntegrationIncidentDrawerProps {
	providerKey: string;
	providerName: string;
	/** Optional statuspage link rendered in the header. */
	statusPageUrl?: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

interface IncidentRow {
	id: string;
	providerKey: string;
	providerName: string;
	severity: "SEV1" | "SEV2" | "SEV3";
	health:
		| "OPERATIONAL"
		| "DEGRADED"
		| "PARTIAL_OUTAGE"
		| "MAJOR_OUTAGE"
		| "MAINTENANCE"
		| "UNKNOWN";
	status: "FIRING" | "ACKNOWLEDGED" | "RESOLVED";
	startedAt: string | Date;
	resolvedAt: string | Date | null;
	summary: string | null;
	affectedComponents: string[];
	statusPageUrl: string | null;
}

interface IncidentsResponse {
	incidents: IncidentRow[];
}

const SEVERITY_LABEL: Record<IncidentRow["severity"], string> = {
	SEV1: "SEV-1",
	SEV2: "SEV-2",
	SEV3: "SEV-3",
};

const SEVERITY_BAR: Record<IncidentRow["severity"], string> = {
	SEV1: "bg-destructive",
	SEV2: "bg-highlight",
	SEV3: "bg-muted-foreground/40",
};

const SEVERITY_TEXT: Record<IncidentRow["severity"], string> = {
	SEV1: "text-destructive",
	SEV2: "text-highlight",
	SEV3: "text-muted-foreground",
};

const HEALTH_LABEL: Record<IncidentRow["health"], string> = {
	OPERATIONAL: "Operational",
	DEGRADED: "Degraded",
	PARTIAL_OUTAGE: "Partial outage",
	MAJOR_OUTAGE: "Major outage",
	MAINTENANCE: "Maintenance",
	UNKNOWN: "Status unavailable",
};

function asDate(value: string | Date | null | undefined): Date | null {
	if (value === null || value === undefined) {
		return null;
	}
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) {
		return null;
	}
	return date;
}

function formatRange(
	startedAt: Date | null,
	resolvedAt: Date | null,
): string | null {
	if (!startedAt) {
		return null;
	}
	const startedLabel = format(startedAt, "MMM d, yyyy 'at' h:mm a");
	if (!resolvedAt) {
		return `${startedLabel} -> Ongoing`;
	}
	const resolvedLabel = format(resolvedAt, "MMM d, yyyy 'at' h:mm a");
	return `${startedLabel} -> ${resolvedLabel}`;
}

function IncidentTimelineRow({ incident }: { incident: IncidentRow }) {
	const started = asDate(incident.startedAt);
	const resolved = asDate(incident.resolvedAt);
	const range = formatRange(started, resolved);
	const isOngoing = !resolved;

	return (
		<li
			data-testid="incident-timeline-row"
			className="relative flex gap-3 rounded-lg border bg-card p-3"
		>
			<span
				aria-hidden="true"
				className={cn(
					"absolute inset-y-3 left-0 w-0.5 rounded-r",
					SEVERITY_BAR[incident.severity],
				)}
			/>
			<div className="flex-1 min-w-0 pl-2">
				<div className="flex items-start justify-between gap-2">
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<span
								className={cn(
									"text-[10px] font-semibold uppercase tracking-[0.18em]",
									SEVERITY_TEXT[incident.severity],
								)}
							>
								{SEVERITY_LABEL[incident.severity]}
							</span>
							<span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
								{HEALTH_LABEL[incident.health]}
							</span>
							{isOngoing ? (
								<span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-destructive">
									Ongoing
								</span>
							) : null}
						</div>
						<p className="mt-1 text-sm text-foreground line-clamp-3">
							{incident.summary?.trim() ||
								(isOngoing
									? "Provider is reporting an active incident."
									: "Provider reported an incident.")}
						</p>
					</div>
				</div>

				{incident.affectedComponents.length > 0 ? (
					<div className="mt-2 flex flex-wrap gap-1">
						{incident.affectedComponents.map((component) => (
							<span
								key={component}
								className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground"
							>
								{component}
							</span>
						))}
					</div>
				) : null}

				<div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
					<span>{range ?? "Unknown timing"}</span>
					{started ? (
						<time
							dateTime={started.toISOString()}
							title={started.toISOString()}
						>
							{formatDistanceToNow(started, { addSuffix: true })}
						</time>
					) : null}
				</div>

				{incident.statusPageUrl ? (
					<a
						href={incident.statusPageUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="mt-2 inline-flex items-center gap-1 text-[11px] underline underline-offset-2 text-primary hover:text-primary/80"
					>
						Open upstream report
						<ExternalLink className="h-3 w-3" />
					</a>
				) : null}
			</div>
		</li>
	);
}

function LoadingSkeleton() {
	return (
		<ul className="space-y-3" aria-busy="true" aria-live="polite">
			{[0, 1, 2].map((index) => (
				<li
					key={index}
					className="rounded-lg border bg-card p-3"
					data-testid="incident-timeline-skeleton"
				>
					<div className="h-3 w-24 rounded bg-muted" />
					<div className="mt-2 h-3 w-3/4 rounded bg-muted" />
					<div className="mt-2 h-3 w-1/2 rounded bg-muted" />
				</li>
			))}
		</ul>
	);
}

function EmptyState({
	providerName,
	statusPageUrl,
}: {
	providerName: string;
	statusPageUrl?: string | null;
}) {
	return (
		<div
			className="flex flex-col items-center gap-3 rounded-lg border border-dashed bg-card/50 px-4 py-10 text-center"
			data-testid="incident-timeline-empty"
		>
			<History
				className="h-8 w-8 text-muted-foreground/60"
				aria-hidden="true"
			/>
			<div>
				<p className="text-sm font-medium text-foreground">
					No incidents in the last 30 days
				</p>
				<p className="mt-1 text-xs text-muted-foreground">
					{providerName} has been reported as operational across the
					window.
				</p>
			</div>
			{statusPageUrl ? (
				<Button
					variant="outline"
					size="sm"
					asChild
					className="mt-1 text-xs"
				>
					<a
						href={statusPageUrl}
						target="_blank"
						rel="noopener noreferrer"
					>
						<ExternalLink
							className="mr-1.5 h-3 w-3"
							aria-hidden="true"
						/>
						Open status page
					</a>
				</Button>
			) : null}
		</div>
	);
}

function ErrorState() {
	return (
		<div
			role="alert"
			className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive"
		>
			Could not load the incident timeline. Please retry shortly.
		</div>
	);
}

export function IntegrationIncidentDrawer({
	providerKey,
	providerName,
	statusPageUrl,
	open,
	onOpenChange,
}: IntegrationIncidentDrawerProps) {
	const { data, isLoading, isError } = useQuery<IncidentsResponse>({
		queryKey: [
			"integrationHealth",
			"getProviderIncidents",
			providerKey,
			30,
		],
		queryFn: () =>
			orpcClient.integrationHealth.getProviderIncidents({
				providerKey,
				windowDays: 30,
			}) as Promise<IncidentsResponse>,
		enabled: open && providerKey.length > 0,
		refetchOnWindowFocus: false,
	});

	const incidents = data?.incidents ?? [];

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				className="w-full sm:max-w-md flex flex-col"
				data-testid="integration-incident-drawer"
			>
				<SheetHeader className="pr-8">
					<div className="flex items-center gap-2">
						<span
							aria-hidden="true"
							className="h-4 w-0.5 shrink-0 bg-primary"
						/>
						<span className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
							Incident history
						</span>
					</div>
					<SheetTitle className="font-serif text-2xl leading-tight">
						{providerName}
					</SheetTitle>
					<SheetDescription className="text-xs">
						Last 30 days of detected incidents. Provider health is
						global -- the same status is shown to every Fabric
						tenant.
					</SheetDescription>
					{statusPageUrl ? (
						<a
							href={statusPageUrl}
							target="_blank"
							rel="noopener noreferrer"
							className="inline-flex w-fit items-center gap-1 text-[11px] underline underline-offset-2 text-primary hover:text-primary/80"
						>
							Provider status page
							<ExternalLink
								className="h-3 w-3"
								aria-hidden="true"
							/>
						</a>
					) : null}
				</SheetHeader>

				<div className="mt-4 flex-1 overflow-y-auto pr-1">
					{isLoading ? (
						<LoadingSkeleton />
					) : isError ? (
						<ErrorState />
					) : incidents.length === 0 ? (
						<EmptyState
							providerName={providerName}
							statusPageUrl={statusPageUrl}
						/>
					) : (
						<ul className="space-y-3">
							{incidents.map((incident) => (
								<IncidentTimelineRow
									key={incident.id}
									incident={incident}
								/>
							))}
						</ul>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}
