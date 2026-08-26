"use client";

/**
 * Admin monitoring dashboard composition. Renders four sections:
 *
 *   1. Active incidents (ErrorRateIncident + IntegrationIncident, FIRING +
 *      ACKNOWLEDGED) — interactive table with inline ack/resolve/comment.
 *   2. Provider health overview — responsive grid of all registered providers.
 *   3. Configuration — read-only display of alert thresholds + recovery
 *      hysteresis. v1 has no edit UI.
 *   4. Incident history — paginated timeline of past incidents (every status
 *      + severity), filterable by window / source / status. Lives at the
 *      bottom: it's the deep-scan archive, not the at-a-glance "what's on
 *      fire now" summary the sections above provide.
 *
 * Visual language follows the editorial direction set in CLAUDE.md:
 *  - Serif page hero
 *  - Uppercase editorial section labels with the red bar prefix
 *  - Dot-grid texture on the header (not animated)
 *  - Warm neutral cards, no glassmorphism
 *  - All colors via CSS variable tokens
 *
 * Accessibility: every opaque term on the page has a `(?)` HelpTooltip
 * explaining it in plain language. The trigger is keyboard-focusable and
 * Radix Tooltip respects `prefers-reduced-motion` automatically.
 */

import { ActiveIncidentsTable } from "./ActiveIncidentsTable";
import { GLOSSARY } from "./glossary";
import { HelpTooltip } from "./HelpTooltip";
import { IncidentTimelineList } from "./IncidentTimelineList";
import { ProviderHealthGrid } from "./ProviderHealthGrid";
import { StatusAnnouncementAuthoring } from "./StatusAnnouncementAuthoring";
import { ThresholdConfigDisplay } from "./ThresholdConfigDisplay";

export function MonitoringDashboard() {
	return (
		<div className="space-y-10 pb-10">
			<header className="relative overflow-hidden rounded-xl border border-border/60 bg-card px-6 py-8 sm:px-8 sm:py-10">
				<div
					className="pointer-events-none absolute inset-0 text-foreground/10 app-dot-grid"
					aria-hidden="true"
				/>
				<div className="relative space-y-3">
					<p className="app-editorial-label">Reliability</p>
					<div className="flex items-center gap-3">
						<h1 className="font-serif text-3xl font-normal tracking-tight text-foreground/95 sm:text-4xl">
							Monitoring
						</h1>
						<HelpTooltip
							label="the monitoring dashboard"
							iconClassName="size-4"
							contentClassName="max-w-sm"
						>
							{GLOSSARY.monitoringOverview}
						</HelpTooltip>
					</div>
					<p className="max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
						Application error budgets, provider health, and the
						incident timeline. Acknowledge or resolve from this
						page; thresholds are read-only and changed via the
						observability rules in code.
					</p>
				</div>
			</header>

			<ActiveIncidentsTable />
			{/* Publishing sits directly beneath the open-incident list because an
			  operator reaches for it while looking at the incident that prompted
			  it — splitting the two would mean navigating away mid-incident. */}
			<StatusAnnouncementAuthoring />
			<ProviderHealthGrid />
			<ThresholdConfigDisplay />
			<IncidentTimelineList />
		</div>
	);
}
