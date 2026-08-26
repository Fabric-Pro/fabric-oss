"use client";

/**
 * GitHubActivityCard — renders GitHub PR activity items in a Daily Brief.
 *
 * Items are split into two groups by the PR's target branch:
 *   - Prod      → base ref === "production"
 *   - Staging   → everything else (PRs to `main` or any feature branch that
 *                 will eventually land on `main`)
 *
 * Prod is rendered first so the most consequential changes sit at the top.
 */

import type { GithubItem, PartialFailure } from "@repo/database";
import { cn } from "@ui/lib";
import { GitPullRequestIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { formatRelativeOccurredAt } from "./format";
import { SourceCard } from "./SourceCard";

const KIND_LABEL: Record<GithubItem["kind"], string> = {
	pr_opened: "Opened",
	pr_merged: "Merged",
	pr_awaiting_review: "Awaiting review",
	pr_closed: "Closed",
};

const KIND_CHIP: Record<GithubItem["kind"], string> = {
	pr_opened: "bg-muted text-muted-foreground border-border",
	pr_merged: "bg-secondary/10 text-secondary border-secondary/30",
	pr_awaiting_review:
		"bg-highlight/10 text-highlight-foreground dark:text-highlight border-highlight/40",
	pr_closed: "bg-muted text-muted-foreground border-border",
};

const PROD_BASE_REF = "production";

function isProdItem(item: GithubItem): boolean {
	return item.baseRef === PROD_BASE_REF;
}

export interface GitHubActivityCardProps {
	items: GithubItem[];
	partialFailure?: PartialFailure;
	/** Override the empty message (e.g. for "since last review" zero state). */
	emptyMessage?: string;
}

type EnvFilter = "all" | "prod" | "staging";

export function GitHubActivityCard({
	items,
	partialFailure,
	emptyMessage = "No GitHub activity in this window.",
}: GitHubActivityCardProps) {
	const [filter, setFilter] = useState<EnvFilter>("all");
	const { prodItems, stagingItems } = useMemo(() => {
		const prod: GithubItem[] = [];
		const staging: GithubItem[] = [];
		for (const item of items) {
			(isProdItem(item) ? prod : staging).push(item);
		}
		return { prodItems: prod, stagingItems: staging };
	}, [items]);

	const showProd = filter === "all" || filter === "prod";
	const showStaging = filter === "all" || filter === "staging";

	return (
		<SourceCard
			title="GitHub activity"
			sourceLabel="Source — GitHub"
			count={items.length}
			emptyMessage={emptyMessage}
			icon={<GitPullRequestIcon className="size-4" />}
			partialFailure={partialFailure}
		>
			{items.length > 0 ? (
				<EnvFilterPills
					filter={filter}
					onChange={setFilter}
					counts={{
						all: items.length,
						prod: prodItems.length,
						staging: stagingItems.length,
					}}
				/>
			) : null}

			<div className="space-y-5">
				{showProd ? (
					<EnvSection
						label="Prod"
						hint="PRs targeting production"
						tone="prod"
						items={prodItems}
					/>
				) : null}
				{showStaging ? (
					<EnvSection
						label="Staging"
						hint="PRs targeting main"
						tone="staging"
						items={stagingItems}
					/>
				) : null}
			</div>
		</SourceCard>
	);
}

function EnvFilterPills({
	filter,
	onChange,
	counts,
}: {
	filter: EnvFilter;
	onChange: (next: EnvFilter) => void;
	counts: { all: number; prod: number; staging: number };
}) {
	const options: Array<{
		value: EnvFilter;
		label: string;
		count: number;
	}> = [
		{ value: "all", label: "All", count: counts.all },
		{ value: "prod", label: "Prod", count: counts.prod },
		{ value: "staging", label: "Staging", count: counts.staging },
	];

	return (
		<div
			role="tablist"
			aria-label="Filter pull requests by environment"
			className="mb-4 inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 p-0.5"
		>
			{options.map((opt) => {
				const isActive = filter === opt.value;
				return (
					<button
						key={opt.value}
						type="button"
						role="tab"
						aria-selected={isActive}
						onClick={() => onChange(opt.value)}
						className={cn(
							"inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-sans text-xs font-medium transition-colors",
							"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
							isActive
								? "bg-card text-foreground shadow-sm"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						<span>{opt.label}</span>
						<span
							className={cn(
								"font-mono text-[10px]",
								isActive
									? "text-muted-foreground"
									: "text-muted-foreground/70",
							)}
						>
							{opt.count}
						</span>
					</button>
				);
			})}
		</div>
	);
}

function EnvSection({
	label,
	hint,
	tone,
	items,
}: {
	label: string;
	hint: string;
	tone: "prod" | "staging";
	items: GithubItem[];
}) {
	const dotClass = tone === "prod" ? "bg-primary" : "bg-muted-foreground/50";

	return (
		<section aria-label={`${label} pull requests`}>
			<header className="flex items-baseline justify-between gap-2 border-b border-border/60 pb-2">
				<div className="flex items-center gap-2">
					<span
						aria-hidden="true"
						className={cn("size-1.5 rounded-full", dotClass)}
					/>
					<span className="font-sans text-xs font-semibold uppercase tracking-[0.18em] text-foreground/80">
						{label}
					</span>
					<span className="text-[11px] text-muted-foreground">
						{hint}
					</span>
				</div>
				<span className="font-mono text-xs text-muted-foreground">
					{items.length}
				</span>
			</header>

			{items.length === 0 ? (
				<p className="mt-3 text-xs text-muted-foreground">
					Nothing here.
				</p>
			) : (
				<ul className="mt-1 divide-y divide-border">
					{items.map((item, index) => (
						<li
							key={`${item.repoFullName}-${item.prNumber}-${item.kind}-${index}`}
							className="py-3"
						>
							<a
								href={item.url}
								target="_blank"
								rel="noreferrer noopener"
								className="group block rounded outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
							>
								<div className="flex items-start justify-between gap-3">
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2">
											<span
												className={cn(
													"inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
													KIND_CHIP[item.kind],
												)}
											>
												{KIND_LABEL[item.kind]}
											</span>
											<span className="truncate font-mono text-xs text-muted-foreground">
												#{item.prNumber} ·{" "}
												{item.repoFullName}
											</span>
										</div>
										<p className="mt-1.5 truncate font-sans text-sm font-medium text-foreground group-hover:text-primary">
											{item.title}
										</p>
										<p className="mt-0.5 text-xs text-muted-foreground">
											{item.author
												? `by ${item.author} · `
												: ""}
											{item.baseRef
												? `→ ${item.baseRef} · `
												: ""}
											{formatRelativeOccurredAt(
												item.occurredAt,
											)}
										</p>
									</div>
								</div>
							</a>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
