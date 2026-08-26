"use client";

/**
 * Read-only display of the alert thresholds and recovery hysteresis policy.
 *
 * The threshold view is read-only in v1 — there is no per-org or per-admin
 * configuration UI yet. Editing thresholds requires a code change + redeploy
 * (the rules live in `packages/observability` and the Prometheus rule files
 * under `deployment/prometheus/rules/`).
 *
 * The values rendered here mirror the multi-window multi-burn-rate policy
 * captured in the Prometheus rule files. Keep this table in sync with the
 * YAML rules — a test in `__tests__/ThresholdConfigDisplay.test.tsx`
 * asserts the canonical strings so a drift in the rules drives a deliberate
 * doc-side update.
 *
 * Every column header and the severity pills carry tooltip explanations so
 * an admin reading this for the first time understands what "burn rate" or
 * "hysteresis" actually mean.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { GLOSSARY } from "./glossary";
import { HelpTooltip, InlineTooltip } from "./HelpTooltip";

type ErrorRateThresholdRow = {
	severity: "SEV-1" | "SEV-2" | "SEV-3";
	longWindow: string;
	shortWindow: string;
	burnRate: string;
	minCount: string;
};

type IntegrationThresholdRow = {
	signal: string;
	severity: "SEV-1" | "SEV-2";
	condition: string;
	hysteresis: string;
};

/** Canonical error-rate burn-rate thresholds. */
export const ERROR_RATE_THRESHOLDS: readonly ErrorRateThresholdRow[] = [
	{
		severity: "SEV-1",
		longWindow: "1h",
		shortWindow: "5m",
		burnRate: "14.4x",
		minCount: "> 10 in 1h",
	},
	{
		severity: "SEV-2",
		longWindow: "6h",
		shortWindow: "30m",
		burnRate: "6x",
		minCount: "> 30 in 6h",
	},
	{
		severity: "SEV-3",
		longWindow: "3d",
		shortWindow: "6h",
		burnRate: "1x",
		minCount: "> 100 in 3d",
	},
] as const;

/** Canonical integration / provider thresholds. */
export const INTEGRATION_THRESHOLDS: readonly IntegrationThresholdRow[] = [
	{
		signal: "ProviderBreakerOpen",
		severity: "SEV-2",
		condition: "Cockatiel breaker state == OPEN for 1m",
		hysteresis: "Breaker returns to CLOSED for 1 minute",
	},
	{
		signal: "ProviderMajorOutage",
		severity: "SEV-1",
		condition: "> 25% errors over 5m AND breaker open",
		hysteresis: "Error rate < 5% for 5 minutes",
	},
	{
		signal: "SyntheticProbeFailing",
		severity: "SEV-2",
		condition: "3 consecutive probe failures (15m)",
		hysteresis: "3 consecutive successful probes",
	},
	{
		signal: "SyntheticProbeMajorFailure",
		severity: "SEV-1",
		condition: "5 consecutive probe failures (25m)",
		hysteresis: "3 consecutive successful probes",
	},
	{
		signal: "StatuspageIncidentDeclared",
		severity: "SEV-2",
		condition: "Provider declares an open incident (2-min poll)",
		hysteresis:
			"incident.resolved webhook OR component.status = operational for 2 polls",
	},
] as const;

/** Recovery hysteresis policy. */
export const HYSTERESIS_POLICY = {
	errorRate: "Rate < 50% of trigger threshold for 10 minutes",
	statuspage:
		"incident.resolved webhook OR component.status = operational for 2 consecutive polls",
	syntheticProbe: "3 consecutive successful probes",
} as const;

function SeverityPill({ severity }: { severity: "SEV-1" | "SEV-2" | "SEV-3" }) {
	const tone =
		severity === "SEV-1"
			? "border-destructive/40 bg-destructive/10 text-destructive"
			: severity === "SEV-2"
				? "border-highlight/40 bg-highlight/10 text-highlight"
				: "border-border/60 bg-muted text-muted-foreground";
	const tooltipText =
		severity === "SEV-1"
			? "SEV-1 — customer-impacting outage. Pages on-call immediately."
			: severity === "SEV-2"
				? "SEV-2 — degraded but functional. Business-hours response."
				: "SEV-3 — chronic issue. Ticket-only, no paging.";
	return (
		<InlineTooltip label={`Severity ${severity}`} content={tooltipText}>
			<span
				className={`inline-flex h-5 items-center rounded-md border px-2 text-[10px] font-medium tracking-wide uppercase ${tone}`}
			>
				{severity}
			</span>
		</InlineTooltip>
	);
}

/** Reusable th wrapper that pairs the column label with a `(?)` tooltip. */
function ThWithTooltip({
	label,
	tooltipLabel,
	children,
	align = "left",
}: {
	label: string;
	tooltipLabel: string;
	children: React.ReactNode;
	align?: "left" | "right";
}) {
	return (
		<th
			scope="col"
			className={`px-3 py-3 ${
				align === "right" ? "text-right" : "text-left"
			} font-medium`}
		>
			<span className="inline-flex items-center gap-1.5">
				<span>{label}</span>
				<HelpTooltip label={tooltipLabel}>{children}</HelpTooltip>
			</span>
		</th>
	);
}

export function ThresholdConfigDisplay() {
	return (
		<section
			aria-labelledby="threshold-config-heading"
			className="space-y-6"
		>
			<div className="space-y-1">
				<p className="app-editorial-label">Configuration</p>
				<div className="flex items-center gap-2">
					<h2
						id="threshold-config-heading"
						className="font-serif text-2xl font-normal tracking-tight text-foreground/95"
					>
						Alert thresholds
					</h2>
					<HelpTooltip label="alert thresholds">
						The multi-window multi-burn-rate policy enforced by
						Alertmanager. Read-only here; editing requires a code
						change in <code>packages/observability</code> and a
						redeploy.
					</HelpTooltip>
				</div>
				<p className="text-sm text-muted-foreground">
					Read-only view of the multi-window multi-burn-rate rules
					currently enforced by Alertmanager. Editing requires a code
					change in <code>packages/observability</code> + redeploy.
				</p>
			</div>

			<Card className="app-surface border-border/60">
				<CardHeader>
					<CardTitle className="text-base font-medium">
						Error-rate burn-rate windows
					</CardTitle>
				</CardHeader>
				<CardContent className="p-0">
					{/* No `overflow-x-auto` wrapper and no `min-w-[*]` on the
					 * table — the user explicitly does not want any of the
					 * monitoring tables to force horizontal scrolling. Cells
					 * use `whitespace-nowrap` for the short data fields
					 * (severity pill, window, burn-rate); the wider `Min
					 * count` cell wraps gracefully on narrow viewports. */}
					<div className="w-full">
						<table
							className="w-full caption-bottom text-sm"
							aria-label="Error-rate burn-rate thresholds by severity"
						>
							<thead className="border-b border-border/60 text-xs uppercase tracking-wider text-muted-foreground">
								<tr>
									<ThWithTooltip
										label="Severity"
										tooltipLabel="severity"
									>
										{GLOSSARY.burnRateSeverity}
									</ThWithTooltip>
									<ThWithTooltip
										label="Long window"
										tooltipLabel="long window"
									>
										{GLOSSARY.burnRateLongWindow}
									</ThWithTooltip>
									<ThWithTooltip
										label="Short window"
										tooltipLabel="short window"
									>
										{GLOSSARY.burnRateShortWindow}
									</ThWithTooltip>
									<ThWithTooltip
										label="Burn rate"
										tooltipLabel="burn rate"
									>
										{GLOSSARY.burnRateMultiplier}
									</ThWithTooltip>
									<ThWithTooltip
										label="Min count"
										tooltipLabel="minimum count"
									>
										{GLOSSARY.burnRateMinCount}
									</ThWithTooltip>
								</tr>
							</thead>
							<tbody>
								{ERROR_RATE_THRESHOLDS.map((row) => (
									<tr
										key={row.severity}
										className="border-b border-border/40 last:border-0"
									>
										<td className="whitespace-nowrap px-3 py-3">
											<SeverityPill
												severity={row.severity}
											/>
										</td>
										<td className="whitespace-nowrap px-3 py-3 font-mono text-xs">
											{row.longWindow}
										</td>
										<td className="whitespace-nowrap px-3 py-3 font-mono text-xs">
											{row.shortWindow}
										</td>
										<td className="whitespace-nowrap px-3 py-3 font-mono text-xs">
											{row.burnRate}
										</td>
										<td className="whitespace-nowrap px-3 py-3 text-muted-foreground">
											{row.minCount}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</CardContent>
			</Card>

			<Card className="app-surface border-border/60">
				<CardHeader>
					<CardTitle className="text-base font-medium">
						Integration / provider signals
					</CardTitle>
				</CardHeader>
				<CardContent className="p-0">
					{/* Same no-overflow rule — let the columns flex to fit. */}
					<div className="w-full">
						<table
							className="w-full caption-bottom text-sm"
							aria-label="Integration provider alert thresholds and recovery hysteresis"
						>
							<thead className="border-b border-border/60 text-xs uppercase tracking-wider text-muted-foreground">
								<tr>
									<ThWithTooltip
										label="Signal"
										tooltipLabel="signal"
									>
										{GLOSSARY.integrationSignal}
									</ThWithTooltip>
									<ThWithTooltip
										label="Severity"
										tooltipLabel="severity"
									>
										{GLOSSARY.burnRateSeverity}
									</ThWithTooltip>
									<ThWithTooltip
										label="Trigger condition"
										tooltipLabel="trigger condition"
									>
										{GLOSSARY.integrationCondition}
									</ThWithTooltip>
									<ThWithTooltip
										label="Recovery hysteresis"
										tooltipLabel="recovery hysteresis"
									>
										{GLOSSARY.integrationHysteresis}
									</ThWithTooltip>
								</tr>
							</thead>
							<tbody>
								{INTEGRATION_THRESHOLDS.map((row) => (
									<tr
										key={row.signal}
										className="border-b border-border/40 last:border-0"
									>
										<td className="break-all px-3 py-3 font-mono text-xs">
											{row.signal}
										</td>
										<td className="whitespace-nowrap px-3 py-3">
											<SeverityPill
												severity={row.severity}
											/>
										</td>
										<td className="px-3 py-3 text-muted-foreground">
											{row.condition}
										</td>
										<td className="px-3 py-3 text-muted-foreground">
											{row.hysteresis}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</CardContent>
			</Card>

			<Card className="app-surface border-border/60">
				<CardHeader>
					<div className="flex items-center gap-2">
						<CardTitle className="text-base font-medium">
							Recovery hysteresis policy
						</CardTitle>
						<HelpTooltip label="recovery hysteresis policy">
							Hysteresis means an incident only auto-closes once
							the underlying signal has been healthy for a
							sustained period — preventing flapping when a metric
							hovers near the trigger threshold.
						</HelpTooltip>
					</div>
				</CardHeader>
				<CardContent className="space-y-3 text-sm">
					{/* Three definition cards — editorial label up top, body
					 * sentence underneath. Stone-toned card surface mirrors
					 * the rest of the dashboard (no glassmorphism). */}
					<dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
						<div className="space-y-1 rounded-md border border-border/40 bg-muted/30 p-3">
							<dt className="inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
								<span>Error rate</span>
								<HelpTooltip label="error-rate hysteresis">
									{GLOSSARY.hysteresisErrorRate}
								</HelpTooltip>
							</dt>
							<dd className="text-sm text-foreground/90">
								{HYSTERESIS_POLICY.errorRate}
							</dd>
						</div>
						<div className="space-y-1 rounded-md border border-border/40 bg-muted/30 p-3">
							<dt className="inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
								<span>Statuspage</span>
								<HelpTooltip label="statuspage hysteresis">
									{GLOSSARY.hysteresisStatuspage}
								</HelpTooltip>
							</dt>
							<dd className="text-sm text-foreground/90">
								{HYSTERESIS_POLICY.statuspage}
							</dd>
						</div>
						<div className="space-y-1 rounded-md border border-border/40 bg-muted/30 p-3">
							<dt className="inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
								<span>Synthetic probe</span>
								<HelpTooltip label="synthetic-probe hysteresis">
									{GLOSSARY.hysteresisSyntheticProbe}
								</HelpTooltip>
							</dt>
							<dd className="text-sm text-foreground/90">
								{HYSTERESIS_POLICY.syntheticProbe}
							</dd>
						</div>
					</dl>
				</CardContent>
			</Card>
		</section>
	);
}
