"use client";

/**
 * Responsive grid of provider health cards for the admin monitoring dashboard.
 *
 * Pulls from `integrationHealth.listProviderHealth` which returns every
 * registered provider in the `IntegrationProviderRegistry` along with the
 * most-recent active incident (if any). Cards render the current
 * `currentHealth`, the last-poll timestamp via `formatDistanceToNow`, and a
 * short summary of the active incident.
 *
 * Layout: cards size on a minmax(240px, 1fr) auto-fit grid rather than a
 * fixed column count. With ~30+ registered providers this prevents the old
 * 3-column layout from cramming three columns at 240px-wide each on a
 * 720px viewport — affected-features and last-poll strings used to truncate
 * mid-word. The new minimum-card-width keeps content readable, lets long
 * provider names wrap to two lines, and lets the affected-features list
 * wrap onto multiple chip rows.
 *
 * Card click semantics: when the shared `IntegrationIncidentDrawer`
 * component is available, the click handler at the bottom of this file can
 * swap from "open the ack/resolve dialog" to "open the drawer". For now,
 * a click on a card with an active incident opens the shared
 * `IncidentAckResolveDialog` so admins still have a path to act on the row
 * without leaving the page.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@ui/components/card";
import { formatDistanceToNowStrict } from "date-fns";
import { useMemo, useState } from "react";
import { GLOSSARY } from "./glossary";
import { HelpTooltip, InlineTooltip } from "./HelpTooltip";
import {
	IncidentAckResolveDialog,
	type IncidentDialogTarget,
	MONITORING_QUERY_KEYS,
} from "./IncidentAckResolveDialog";

type ProviderHealthRow = {
	id: string;
	providerKey: string;
	displayName: string;
	currentHealth:
		| "OPERATIONAL"
		| "DEGRADED"
		| "PARTIAL_OUTAGE"
		| "MAJOR_OUTAGE"
		| "MAINTENANCE"
		| "UNKNOWN"
		| "NOT_CONFIGURED";
	lastPolledAt: Date | null;
	statusPageUrl: string | null;
	affectedFeatures: string[];
	activeIncident: {
		id: string;
		summary: string | null;
		severity: "SEV1" | "SEV2" | "SEV3";
		status: "FIRING" | "ACKNOWLEDGED" | "RESOLVED";
		startedAt: Date;
	} | null;
};

const HEALTH_TONE: Record<
	ProviderHealthRow["currentHealth"],
	{ label: string; cls: string; tooltipKey: keyof typeof GLOSSARY }
> = {
	OPERATIONAL: {
		label: "Operational",
		cls: "border-secondary/40 bg-secondary/10 text-secondary",
		tooltipKey: "healthOperational",
	},
	DEGRADED: {
		label: "Degraded",
		cls: "border-highlight/40 bg-highlight/10 text-highlight",
		tooltipKey: "healthDegraded",
	},
	PARTIAL_OUTAGE: {
		label: "Partial outage",
		cls: "border-highlight/40 bg-highlight/10 text-highlight",
		tooltipKey: "healthPartialOutage",
	},
	MAJOR_OUTAGE: {
		label: "Major outage",
		cls: "border-destructive/40 bg-destructive/10 text-destructive",
		tooltipKey: "healthMajorOutage",
	},
	MAINTENANCE: {
		label: "Maintenance",
		cls: "border-border/60 bg-muted text-muted-foreground",
		tooltipKey: "healthMaintenance",
	},
	UNKNOWN: {
		label: "Unknown",
		cls: "border-border/60 bg-muted text-muted-foreground",
		tooltipKey: "healthUnknown",
	},
	NOT_CONFIGURED: {
		label: "Not configured",
		// Neutral gray — distinct from MAJOR_OUTAGE (destructive). This
		// status means the synthetic probe is disabled because the required
		// env var is missing in this environment, NOT that the provider is
		// down. The tooltip below explains the distinction.
		cls: "border-border/60 bg-muted text-muted-foreground",
		tooltipKey: "healthNotConfigured",
	},
};

export function ProviderHealthGrid() {
	const query = useQuery({
		queryKey: MONITORING_QUERY_KEYS.integrationProviders,
		queryFn: async () => {
			const result =
				await orpcClient.integrationHealth.listProviderHealth({});
			return result.providers as unknown as Array<
				Omit<ProviderHealthRow, "lastPolledAt" | "activeIncident"> & {
					lastPolledAt: string | Date | null;
					activeIncident: null | {
						id: string;
						summary: string | null;
						severity: ProviderHealthRow["activeIncident"] extends infer T
							? T extends { severity: infer S }
								? S
								: never
							: never;
						status: "FIRING" | "ACKNOWLEDGED" | "RESOLVED";
						startedAt: string | Date;
					};
				}
			>;
		},
	});

	const providers = useMemo<ProviderHealthRow[]>(() => {
		if (!query.data) {
			return [];
		}
		return query.data.map((p) => ({
			id: p.id,
			providerKey: p.providerKey,
			displayName: p.displayName,
			currentHealth: p.currentHealth,
			lastPolledAt: p.lastPolledAt ? new Date(p.lastPolledAt) : null,
			statusPageUrl: p.statusPageUrl ?? null,
			affectedFeatures: p.affectedFeatures ?? [],
			activeIncident: p.activeIncident
				? {
						id: p.activeIncident.id,
						summary: p.activeIncident.summary,
						severity: p.activeIncident
							.severity as ProviderHealthRow["activeIncident"] extends infer T
							? T extends { severity: infer S }
								? S
								: never
							: never,
						status: p.activeIncident.status,
						startedAt: new Date(p.activeIncident.startedAt),
					}
				: null,
		}));
	}, [query.data]);

	const [dialogOpen, setDialogOpen] = useState(false);
	const [dialogTarget, setDialogTarget] =
		useState<IncidentDialogTarget | null>(null);

	function handleCardActivate(row: ProviderHealthRow) {
		if (!row.activeIncident) {
			return;
		}
		setDialogTarget({
			kind: "integration",
			incidentId: row.activeIncident.id,
			providerName: row.displayName,
			status: row.activeIncident.status,
		});
		setDialogOpen(true);
	}

	return (
		<section
			aria-labelledby="provider-health-heading"
			className="space-y-4"
		>
			<header className="space-y-1">
				<p className="app-editorial-label">Providers</p>
				<div className="flex items-center gap-2">
					<h2
						id="provider-health-heading"
						className="font-serif text-2xl font-normal tracking-tight text-foreground/95"
					>
						Provider health
					</h2>
					<HelpTooltip label="provider health">
						Rollup of the Statuspage poll and the Cockatiel circuit
						breaker for every registered third-party provider. Click
						a card with an open incident to acknowledge, resolve, or
						comment.
					</HelpTooltip>
				</div>
				<p className="text-sm text-muted-foreground">
					Statuspage poll + circuit-breaker rollup for every
					registered provider. Click a card with an open incident to
					acknowledge, resolve, or comment.
				</p>
			</header>

			{query.isLoading ? (
				<div className="rounded-lg border border-border/60 bg-card p-6 text-sm text-muted-foreground">
					Loading provider health...
				</div>
			) : query.isError ? (
				<div className="rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-sm text-destructive">
					Failed to load provider health.
				</div>
			) : providers.length === 0 ? (
				<div className="rounded-lg border border-border/60 bg-card p-6 text-sm text-muted-foreground">
					No providers registered.
				</div>
			) : (
				<ul
					className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]"
					data-testid="provider-health-grid"
				>
					{providers.map((row) => {
						const tone = HEALTH_TONE[row.currentHealth];
						const clickable = row.activeIncident !== null;
						return (
							<li key={row.id}>
								<Card
									className={`app-surface h-full border-border/60 transition-colors ${
										clickable
											? "cursor-pointer hover:border-primary/40"
											: ""
									}`}
									data-testid={`provider-card-${row.providerKey}`}
									tabIndex={clickable ? 0 : undefined}
									role={clickable ? "button" : undefined}
									aria-label={
										clickable
											? `Open incident actions for ${row.displayName}`
											: undefined
									}
									onClick={
										clickable
											? () => handleCardActivate(row)
											: undefined
									}
									onKeyDown={
										clickable
											? (e) => {
													if (
														e.key === "Enter" ||
														e.key === " "
													) {
														e.preventDefault();
														handleCardActivate(row);
													}
												}
											: undefined
									}
								>
									<CardContent className="flex h-full flex-col gap-3 p-4">
										<div className="flex items-start justify-between gap-2">
											<div className="min-w-0 flex-1">
												<p
													className="break-words text-sm font-medium text-foreground/90"
													title={row.displayName}
												>
													{row.displayName}
												</p>
												<p
													className="break-all text-xs text-muted-foreground"
													title={row.providerKey}
												>
													{row.providerKey}
												</p>
											</div>
											<InlineTooltip
												label={`Health: ${tone.label}`}
												content={
													GLOSSARY[tone.tooltipKey]
												}
											>
												<span
													className={`inline-flex h-5 shrink-0 items-center rounded-md border px-1.5 text-[10px] font-medium uppercase tracking-wide ${tone.cls}`}
												>
													{tone.label}
												</span>
											</InlineTooltip>
										</div>
										<dl className="grid gap-2 text-xs text-muted-foreground">
											<div className="flex flex-wrap items-center justify-between gap-2">
												<dt className="inline-flex items-center gap-1 uppercase tracking-wider">
													<span>Last poll</span>
													<HelpTooltip label="last poll">
														{GLOSSARY.lastPoll}
													</HelpTooltip>
												</dt>
												<dd className="text-foreground/80">
													{formatLastPoll(
														row.lastPolledAt,
													)}
												</dd>
											</div>
											{row.affectedFeatures.length > 0 ? (
												<div className="flex flex-col gap-1.5">
													<dt className="inline-flex items-center gap-1 uppercase tracking-wider">
														<span>Features</span>
														<HelpTooltip label="affected features">
															{
																GLOSSARY.affectedFeatures
															}
														</HelpTooltip>
													</dt>
													<dd className="flex flex-wrap gap-1">
														{row.affectedFeatures.map(
															(feature) => (
																<span
																	key={
																		feature
																	}
																	className="inline-flex items-center rounded-md border border-border/60 bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium text-foreground/80"
																>
																	{feature}
																</span>
															),
														)}
													</dd>
												</div>
											) : null}
										</dl>
										{row.activeIncident ? (
											<p className="line-clamp-3 rounded-md bg-destructive/5 px-2 py-1.5 text-xs text-destructive/90">
												{row.activeIncident.summary ??
													"Active incident — click to act."}
											</p>
										) : null}
									</CardContent>
								</Card>
							</li>
						);
					})}
				</ul>
			)}

			<IncidentAckResolveDialog
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				target={dialogTarget}
				defaultAction="acknowledge"
			/>
		</section>
	);
}

/**
 * Render the last-poll time as a short distance ("3m ago"). Renders an em
 * dash when the registry has never been polled (`lastPolledAt = null`).
 *
 * Exported for unit tests; `date-fns` handles the locale-independent string.
 */
export function formatLastPoll(date: Date | null): string {
	if (!date) {
		return "—";
	}
	return `${formatDistanceToNowStrict(date)} ago`;
}
