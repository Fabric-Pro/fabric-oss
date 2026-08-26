"use client";

/**
 * DailyBriefHeader — top of the Daily Brief page.
 *
 * Contains:
 * - Editorial section label
 * - Serif h1 heading
 * - Generated-ago timestamp
 * - Time-window segmented control (24h / 7d / 2w)
 * - "Since my last review" toggle (disabled when there is no cursor)
 * - Regenerate CTA
 */

import type { TimeWindowKind } from "@repo/database";
import { PageTourButton } from "@saas/get-started/components/PageTourButton";
import { Button } from "@ui/components/button";
import { Switch } from "@ui/components/switch";
import { cn } from "@ui/lib";
import { RefreshCwIcon } from "lucide-react";
import { formatRelativeOccurredAt } from "./format";

type SupportedKind = Extract<
	TimeWindowKind,
	"LAST_24H" | "LAST_7D" | "LAST_2W"
>;

const WINDOW_OPTIONS: Array<{ value: SupportedKind; label: string }> = [
	{ value: "LAST_24H", label: "24 h" },
	{ value: "LAST_7D", label: "7 d" },
	{ value: "LAST_2W", label: "2 w" },
];

export interface DailyBriefHeaderProps {
	timeWindow: SupportedKind;
	onTimeWindowChange: (kind: SupportedKind) => void;
	/** When true, items are filtered to "since my last review". */
	sinceLastReviewMode: boolean;
	onSinceLastReviewModeChange: (enabled: boolean) => void;
	/** When null/undefined, the toggle is disabled — no cursor yet. */
	cursor: Date | null;
	/** When the brief was generated. */
	generatedAt?: Date;
	/** True while a regenerate request is in flight. */
	isRegenerating?: boolean;
	onRegenerate?: () => void;
}

export function DailyBriefHeader({
	timeWindow,
	onTimeWindowChange,
	sinceLastReviewMode,
	onSinceLastReviewModeChange,
	cursor,
	generatedAt,
	isRegenerating = false,
	onRegenerate,
}: DailyBriefHeaderProps) {
	const toggleDisabled = cursor === null;

	return (
		<header className="relative overflow-hidden rounded-2xl border border-border bg-card">
			<div
				className="pointer-events-none absolute inset-0 opacity-40"
				style={{
					backgroundImage:
						"radial-gradient(circle, rgba(0,0,0,0.13) 1px, transparent 1px)",
					backgroundSize: "32px 32px",
				}}
				aria-hidden="true"
			/>

			<div className="relative flex flex-col gap-6 p-6 sm:p-8 lg:flex-row lg:items-end lg:justify-between">
				<div className="min-w-0">
					<span className="editorial-label">Daily Brief</span>
					<div className="mt-4 flex items-center gap-1.5">
						<h1 className="font-serif text-4xl font-normal leading-[1.1] text-foreground sm:text-5xl">
							Here's what moved today.
						</h1>
						<PageTourButton pageId="daily-brief" />
					</div>
					<p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
						A single-pane view of priorities and project activity,
						refreshed when you need it.
					</p>
					{generatedAt ? (
						<p className="mt-4 text-xs text-muted-foreground">
							Generated {formatRelativeOccurredAt(generatedAt)}
						</p>
					) : null}
				</div>

				<div className="flex flex-col items-stretch gap-3 lg:items-end">
					<div
						data-onboarding-target="daily-brief-window"
						role="radiogroup"
						aria-label="Time window"
						className="inline-flex items-center rounded-md border border-border bg-muted p-0.5"
					>
						{WINDOW_OPTIONS.map((opt) => {
							const active = opt.value === timeWindow;
							return (
								<button
									key={opt.value}
									type="button"
									aria-pressed={active}
									onClick={() =>
										onTimeWindowChange(opt.value)
									}
									className={cn(
										"rounded-sm px-3 py-1.5 text-xs font-medium uppercase tracking-[0.14em] transition-colors duration-200",
										active
											? "bg-card text-foreground shadow-sm"
											: "text-muted-foreground hover:text-foreground",
									)}
								>
									{opt.label}
								</button>
							);
						})}
					</div>

					<div
						data-onboarding-target="daily-brief-since-review"
						className={cn(
							"inline-flex items-center gap-2 text-xs text-muted-foreground",
							toggleDisabled && "opacity-60",
						)}
					>
						<Switch
							id="daily-brief-since-last-review-switch"
							checked={sinceLastReviewMode}
							onCheckedChange={onSinceLastReviewModeChange}
							disabled={toggleDisabled}
							aria-label="Show only changes since my last review"
						/>
						<label
							htmlFor="daily-brief-since-last-review-switch"
							className={cn(
								toggleDisabled && "cursor-not-allowed",
							)}
						>
							Since my last review
							{toggleDisabled ? (
								<span className="ml-1 text-muted-foreground/70">
									(first visit)
								</span>
							) : null}
						</label>
					</div>

					{onRegenerate ? (
						<Button
							data-onboarding-target="daily-brief-regenerate"
							variant="outline"
							size="sm"
							onClick={onRegenerate}
							loading={isRegenerating}
							className="self-end"
						>
							<RefreshCwIcon
								className="size-3.5"
								aria-hidden="true"
							/>
							Regenerate
						</Button>
					) : null}
				</div>
			</div>
		</header>
	);
}
