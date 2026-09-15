/**
 * Customer outcomes page (plan Slice 8) — read-only, token-scoped.
 *
 * Renders the restricted `CustomerOutcomesDto` and nothing else. No hooks,
 * so it works as a server component on /share/outcomes/[token] and as the
 * in-app preview. Editorial style per CLAUDE.md: serif h1, uppercase
 * section labels with the red bar, dot-grid header, paper-like cards.
 */
import type { CustomerOutcomesDto } from "@repo/api/modules/outcomes/lib/customer-outcomes";
import { cn } from "@ui/lib";

export interface CustomerOutcomesViewProps {
	outcomes: CustomerOutcomesDto;
	/** Compact variant for the in-app preview card. */
	embedded?: boolean;
}

const dateFormatter = new Intl.DateTimeFormat("en-US", {
	year: "numeric",
	month: "short",
	day: "numeric",
});

function formatDate(value: Date | string | null | undefined): string {
	if (!value) {
		return "—";
	}
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? "—" : dateFormatter.format(date);
}

function formatValue(value: number | null): string {
	if (value === null || value === undefined) {
		return "—";
	}
	return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function metricTrend(metric: CustomerOutcomesDto["metrics"][number]): {
	label: string;
	tone: "good" | "bad" | "flat";
} {
	const { direction, lastValue, previousValue } = metric;
	if (
		lastValue === null ||
		previousValue === null ||
		lastValue === previousValue
	) {
		return { label: "no change", tone: "flat" };
	}
	const rose = lastValue > previousValue;
	const good = direction === "UP" ? rose : !rose;
	return { label: rose ? "up" : "down", tone: good ? "good" : "bad" };
}

function SectionLabel({ children }: { children: React.ReactNode }) {
	return <span className="editorial-label">{children}</span>;
}

function EmptyLine({ children }: { children: React.ReactNode }) {
	return <p className="mt-3 text-sm text-muted-foreground">{children}</p>;
}

export function CustomerOutcomesView({
	outcomes,
	embedded,
}: CustomerOutcomesViewProps) {
	const { projectName, visionPurpose, visionCoreActions, visionCycle } =
		outcomes;

	return (
		<article
			className={cn(
				"mx-auto w-full max-w-3xl text-foreground",
				embedded ? "px-4 py-6" : "px-4 py-10 sm:px-6 sm:py-16",
			)}
			aria-label={`${projectName} outcomes`}
		>
			<header className="bg-dot-grid relative rounded-2xl border border-border bg-card px-5 py-8 sm:px-8 sm:py-10">
				<SectionLabel>Outcomes</SectionLabel>
				<h1 className="mt-3 font-serif text-3xl font-normal leading-tight sm:text-4xl">
					{projectName}
				</h1>
				{visionPurpose ? (
					<p className="mt-4 max-w-prose text-base leading-7 text-foreground/85">
						{visionPurpose}
					</p>
				) : null}
				{visionCoreActions.length > 0 || visionCycle ? (
					<dl className="mt-6 grid gap-4 text-sm sm:grid-cols-2">
						{visionCoreActions.length > 0 ? (
							<div>
								<dt className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
									Core actions
								</dt>
								<dd className="mt-1 flex flex-wrap gap-1.5">
									{visionCoreActions.map((action) => (
										<span
											key={action}
											className="rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs"
										>
											{action}
										</span>
									))}
								</dd>
							</div>
						) : null}
						{visionCycle ? (
							<div>
								<dt className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
									Cycle
								</dt>
								<dd className="mt-1">{visionCycle}</dd>
							</div>
						) : null}
					</dl>
				) : null}
			</header>

			<div className="mt-8 grid gap-8">
				<section
					aria-labelledby="outcomes-metrics"
					className="rounded-2xl border border-border bg-muted/40 p-5 sm:p-6"
				>
					<SectionLabel>Success metrics</SectionLabel>
					<h2 id="outcomes-metrics" className="sr-only">
						Success metrics
					</h2>
					{outcomes.metrics.length === 0 ? (
						<EmptyLine>No metrics defined yet.</EmptyLine>
					) : (
						<ul className="mt-4 grid gap-3 sm:grid-cols-2">
							{outcomes.metrics.map((metric) => {
								const trend = metricTrend(metric);
								return (
									<li
										key={metric.name}
										className="rounded-xl border border-border bg-card p-4"
									>
										<div className="flex items-baseline justify-between gap-3">
											<span className="text-sm font-medium">
												{metric.name}
											</span>
											<span
												className={cn(
													"font-mono text-[10px] uppercase tracking-wider",
													trend.tone === "good" &&
														"text-secondary",
													trend.tone === "bad" &&
														"text-destructive",
													trend.tone === "flat" &&
														"text-muted-foreground",
												)}
											>
												{trend.label}
											</span>
										</div>
										<div className="mt-2 flex items-baseline gap-2">
											<span className="text-2xl font-semibold tabular-nums">
												{formatValue(metric.lastValue)}
											</span>
											{metric.previousValue !== null ? (
												<span className="text-xs text-muted-foreground tabular-nums">
													from{" "}
													{formatValue(
														metric.previousValue,
													)}
												</span>
											) : null}
										</div>
										<div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
											<span>
												{metric.direction === "UP"
													? "Higher is better"
													: "Lower is better"}
											</span>
											{metric.target !== null ? (
												<span>
													Target{" "}
													{formatValue(metric.target)}
												</span>
											) : null}
											<span>
												Observed{" "}
												{formatDate(
													metric.lastObservedAt,
												)}
											</span>
										</div>
									</li>
								);
							})}
						</ul>
					)}
				</section>

				<section
					aria-labelledby="outcomes-shipped"
					className="rounded-2xl border border-border bg-muted/40 p-5 sm:p-6"
				>
					<SectionLabel>Shipped</SectionLabel>
					<h2 id="outcomes-shipped" className="sr-only">
						Shipped
					</h2>
					{outcomes.shipped.length === 0 ? (
						<EmptyLine>Nothing merged yet.</EmptyLine>
					) : (
						<ul className="mt-4 divide-y divide-border/60">
							{outcomes.shipped.map((item) => (
								<li
									key={`${item.storyIdentifier}-${item.pullRequestUrl}`}
									className="flex flex-col gap-1 py-3 sm:flex-row sm:items-baseline sm:justify-between"
								>
									<div className="min-w-0">
										<span className="mr-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
											{item.storyIdentifier}
										</span>
										<a
											href={item.pullRequestUrl}
											target="_blank"
											rel="noreferrer noopener"
											className="text-sm text-primary hover:underline"
										>
											{item.storyTitle}
										</a>
									</div>
									<time
										dateTime={new Date(
											item.mergedAt,
										).toISOString()}
										className="text-xs text-muted-foreground"
									>
										{formatDate(item.mergedAt)}
									</time>
								</li>
							))}
						</ul>
					)}
				</section>

				<section
					aria-labelledby="outcomes-demos"
					className="rounded-2xl border border-border bg-muted/40 p-5 sm:p-6"
				>
					<SectionLabel>Demos</SectionLabel>
					<h2 id="outcomes-demos" className="sr-only">
						Demos
					</h2>
					{outcomes.demos.length === 0 ? (
						<EmptyLine>No accepted spikes yet.</EmptyLine>
					) : (
						<ul className="mt-4 divide-y divide-border/60">
							{outcomes.demos.map((demo, index) => (
								<li
									key={`${demo.storyIdentifier}-${index}`}
									className="flex flex-col gap-1 py-3 sm:flex-row sm:items-baseline sm:justify-between"
								>
									<div className="min-w-0">
										<span className="mr-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
											{demo.storyIdentifier}
										</span>
										<span className="text-sm">
											{demo.title}
										</span>
									</div>
									{demo.frameShareUrl ? (
										<a
											href={demo.frameShareUrl}
											target="_blank"
											rel="noreferrer noopener"
											className="text-xs text-primary hover:underline"
										>
											Open demo
										</a>
									) : (
										<span className="text-xs text-muted-foreground">
											Shown on request
										</span>
									)}
								</li>
							))}
						</ul>
					)}
				</section>

				<section
					aria-labelledby="outcomes-decisions"
					className="rounded-2xl border border-border bg-muted/40 p-5 sm:p-6"
				>
					<SectionLabel>Decisions</SectionLabel>
					<h2 id="outcomes-decisions" className="sr-only">
						Decisions
					</h2>
					{outcomes.decisions.length === 0 ? (
						<EmptyLine>No decisions recorded yet.</EmptyLine>
					) : (
						<ol className="mt-4 divide-y divide-border/60">
							{outcomes.decisions.map((decision, index) => (
								<li
									key={`${decision.storyIdentifier}-${index}`}
									className="grid gap-1 py-3 sm:grid-cols-[7rem_1fr]"
								>
									<time
										dateTime={new Date(
											decision.decidedAt,
										).toISOString()}
										className="text-xs text-muted-foreground"
									>
										{formatDate(decision.decidedAt)}
									</time>
									<div className="min-w-0">
										<p className="text-sm">
											{decision.summary}
										</p>
										<p className="mt-0.5 text-xs text-muted-foreground">
											<span className="mr-2 font-mono text-[10px] uppercase tracking-wider">
												{decision.storyIdentifier}
											</span>
											{decision.storyTitle}
										</p>
									</div>
								</li>
							))}
						</ol>
					)}
				</section>
			</div>

			{!embedded ? (
				<footer className="mt-10 text-center text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
					Shared from Fabric
				</footer>
			) : null}
		</article>
	);
}
