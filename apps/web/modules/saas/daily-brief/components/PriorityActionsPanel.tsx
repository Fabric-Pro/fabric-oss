"use client";

/**
 * PriorityActionsPanel — the "what to do next" panel at the top of the
 * Daily Brief. Groups `PriorityAction[]` by kind and renders each with an
 * appropriate color:
 *
 * - `blocker`              → `--destructive`
 * - `story_stale`          → `--highlight` (amber)
 * - `due_date_risk`        → `--highlight` (amber)
 * - `missing_ownership`    → muted
 * - `pr_review_stale`      → muted
 * - `unresolved_dependency`→ muted
 *
 * Note: Priority actions are ALWAYS rendered in full — they do NOT filter
 * under the "since my last review" toggle. That's intentional: urgency is
 * not a "since" concept.
 */

import type { PriorityAction } from "@repo/database";
import { cn } from "@ui/lib";
import {
	AlertCircleIcon,
	ClockIcon,
	GitPullRequestIcon,
	HourglassIcon,
	LightbulbIcon,
	LinkIcon,
	ShieldAlertIcon,
	UserMinusIcon,
} from "lucide-react";
import Link from "next/link";

type Kind = PriorityAction["kind"];
type TargetType = PriorityAction["targetType"];

const TARGET_TYPE_LABELS: Record<TargetType, string> = {
	story: "Story",
	task: "Task",
	document: "Document",
	scan: "Scan",
	architecture_decision: "Architecture decision",
};

const KIND_META: Record<
	Kind,
	{
		label: string;
		tone: "destructive" | "highlight" | "muted";
		icon: typeof AlertCircleIcon;
	}
> = {
	security_findings: {
		label: "Security findings",
		tone: "destructive",
		icon: ShieldAlertIcon,
	},
	decisions_proposed: {
		label: "Decisions awaiting review",
		tone: "highlight",
		icon: LightbulbIcon,
	},
	blocker: {
		label: "Blocker",
		tone: "destructive",
		icon: AlertCircleIcon,
	},
	story_stale: {
		label: "Stalled",
		tone: "highlight",
		icon: HourglassIcon,
	},
	due_date_risk: {
		label: "Due-date risk",
		tone: "highlight",
		icon: ClockIcon,
	},
	missing_ownership: {
		label: "Missing ownership",
		tone: "muted",
		icon: UserMinusIcon,
	},
	pr_review_stale: {
		label: "Stale review",
		tone: "muted",
		icon: GitPullRequestIcon,
	},
	unresolved_dependency: {
		label: "Unresolved dependency",
		tone: "muted",
		icon: LinkIcon,
	},
};

const ORDER: Kind[] = [
	"security_findings",
	"blocker",
	"decisions_proposed",
	"story_stale",
	"due_date_risk",
	"missing_ownership",
	"pr_review_stale",
	"unresolved_dependency",
];

function toneClasses(tone: "destructive" | "highlight" | "muted") {
	switch (tone) {
		case "destructive":
			return {
				border: "border-destructive/40",
				bg: "bg-destructive/5",
				icon: "text-destructive",
				chip: "bg-destructive/10 text-destructive border-destructive/30",
			};
		case "highlight":
			return {
				border: "border-highlight/40",
				bg: "bg-highlight/5",
				icon: "text-highlight",
				chip: "bg-highlight/10 text-highlight-foreground dark:text-highlight border-highlight/40",
			};
		default:
			return {
				border: "border-border",
				bg: "bg-muted/40",
				icon: "text-muted-foreground",
				chip: "bg-muted text-muted-foreground border-border",
			};
	}
}

export interface PriorityActionsPanelProps {
	actions: PriorityAction[];
}

export function PriorityActionsPanel({ actions }: PriorityActionsPanelProps) {
	const grouped = ORDER.map((kind) => ({
		kind,
		items: actions.filter((a) => a.kind === kind),
	})).filter((g) => g.items.length > 0);

	return (
		<section
			aria-labelledby="priority-actions-heading"
			className="rounded-2xl border border-border bg-card p-6"
			data-onboarding-target="daily-brief-priority-actions"
		>
			<header className="flex items-baseline justify-between gap-4">
				<div>
					<span className="editorial-label">What to act on</span>
					<h2
						id="priority-actions-heading"
						className="mt-3 font-sans text-xl font-medium tracking-tight text-foreground"
					>
						Priority actions
					</h2>
				</div>
				<span className="shrink-0 rounded-full border border-border bg-muted px-2.5 py-0.5 font-sans text-xs font-medium text-muted-foreground">
					<span className="sr-only">
						{actions.length} priority actions
					</span>
					<span aria-hidden="true">{actions.length}</span>
				</span>
			</header>

			{actions.length === 0 ? (
				<p className="mt-5 text-sm text-muted-foreground">
					Nothing urgent. The project looks healthy right now.
				</p>
			) : (
				<ol className="mt-5 space-y-6">
					{grouped.map((group) => {
						const meta = KIND_META[group.kind];
						const tone = toneClasses(meta.tone);
						const Icon = meta.icon;

						return (
							<li key={group.kind} className="space-y-2">
								<div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
									<Icon
										className={cn("size-3.5", tone.icon)}
										aria-hidden="true"
									/>
									<span>{meta.label}</span>
									<span className="text-muted-foreground/60">
										· {group.items.length}
									</span>
								</div>

								<ul className="space-y-2">
									{group.items.map((action) => {
										const ariaLabel = `${action.targetIdentifier}: ${action.title} — ${meta.label}`;
										return (
											<li
												key={`${action.kind}-${action.targetCuid}`}
												className={cn(
													"rounded-lg border p-4 transition-colors duration-200",
													tone.border,
													tone.bg,
												)}
											>
												<Link
													href={action.fabricLink}
													aria-label={ariaLabel}
													className="group block outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 rounded"
												>
													<div className="flex items-start justify-between gap-3">
														<div className="min-w-0">
															<div className="flex items-center gap-2">
																<span
																	className={cn(
																		"inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono text-[10px] font-medium tracking-wide",
																		tone.chip,
																	)}
																>
																	{
																		action.targetIdentifier
																	}
																</span>
																<span className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
																	{
																		TARGET_TYPE_LABELS[
																			action
																				.targetType
																		]
																	}
																</span>
															</div>
															<p className="mt-2 font-sans text-sm font-medium text-foreground group-hover:text-primary">
																{action.title}
															</p>
															<p className="mt-1 text-sm leading-6 text-muted-foreground">
																{
																	action.whyItMatters
																}
															</p>
														</div>
													</div>
												</Link>
											</li>
										);
									})}
								</ul>
							</li>
						);
					})}
				</ol>
			)}
		</section>
	);
}
