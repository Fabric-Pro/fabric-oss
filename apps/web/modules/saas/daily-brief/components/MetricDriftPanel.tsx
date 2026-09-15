import type { MetricDriftItem } from "@repo/database";
import { cn } from "@ui/lib";

export interface MetricDriftPanelProps {
	items: MetricDriftItem[];
	/** Link to the project's Outcomes tab (metrics live there). */
	outcomesLink?: string;
}

const REASON_LABEL: Record<MetricDriftItem["reasons"][number], string> = {
	moved_against_direction: "Moved the wrong way",
	missed_target: "Below target",
	stale_observation: "No recent value",
};

function formatValue(value: number | null): string {
	if (value === null) {
		return "—";
	}
	return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatObserved(value: Date | string | null): string {
	if (!value) {
		return "never observed";
	}
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) {
		return "never observed";
	}
	return `observed ${date.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	})}`;
}

/**
 * Daily Brief "Metric drift" section (plan Slice 8, schema v3). Rendered
 * only when the brief carries `metricDrift`; older briefs never do.
 */
export function MetricDriftPanel({
	items,
	outcomesLink,
}: MetricDriftPanelProps) {
	if (items.length === 0) {
		return null;
	}
	return (
		<section
			aria-label="Metric drift"
			className="rounded-2xl border border-highlight/40 bg-highlight/5 p-6"
		>
			<div className="flex items-baseline justify-between gap-3">
				<span className="editorial-label">Metric drift</span>
				{outcomesLink ? (
					<a
						href={outcomesLink}
						className="text-xs text-primary hover:underline"
					>
						Open outcomes
					</a>
				) : null}
			</div>
			<ul className="mt-4 divide-y divide-border/60">
				{items.map((item) => {
					const missedTarget = item.reasons.includes("missed_target");
					return (
						<li
							key={item.metricId}
							className="flex flex-col gap-1 py-2 sm:flex-row sm:items-baseline sm:justify-between"
						>
							<div className="min-w-0">
								<span className="text-sm font-medium">
									{item.name}
								</span>
								<span className="ml-2 text-xs text-muted-foreground">
									{item.direction === "UP"
										? "higher is better"
										: "lower is better"}
									{" · "}
									{formatObserved(item.lastObservedAt)}
								</span>
								<div className="mt-1 flex flex-wrap gap-1.5">
									{item.reasons.map((reason) => (
										<span
											key={reason}
											className={cn(
												"rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider",
												reason === "stale_observation"
													? "border-border bg-muted text-muted-foreground"
													: "border-highlight/40 bg-highlight/10 text-highlight-foreground",
											)}
										>
											{REASON_LABEL[reason]}
										</span>
									))}
								</div>
							</div>
							<div className="text-sm tabular-nums">
								<span className="font-semibold">
									{formatValue(item.lastValue)}
								</span>
								{item.previousValue !== null ? (
									<span className="ml-1 text-xs text-muted-foreground">
										from {formatValue(item.previousValue)}
									</span>
								) : null}
								{item.target !== null ? (
									<span
										className={cn(
											"ml-2 text-xs",
											missedTarget
												? "text-destructive"
												: "text-muted-foreground",
										)}
									>
										target {formatValue(item.target)}
									</span>
								) : null}
							</div>
						</li>
					);
				})}
			</ul>
		</section>
	);
}
