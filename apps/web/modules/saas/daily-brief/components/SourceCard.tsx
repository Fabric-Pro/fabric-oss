"use client";

/**
 * SourceCard — warm-neutral shell used by every source-specific card on the
 * Daily Brief page. Renders the editorial label, an item count, an optional
 * partial-failure banner, and the caller's children (list of items).
 *
 * Follows the "warm stone" direction: `bg-card` surface, subtle border, no
 * glassmorphism. Cards should feel like paper, not floating panels.
 */

import type { PartialFailure } from "@repo/database";
import { cn } from "@ui/lib";
import { AlertTriangleIcon } from "lucide-react";
import type { ReactNode } from "react";

export interface SourceCardProps {
	/** Card heading, e.g. "GitHub activity". */
	title: string;
	/** Editorial section label above the title, e.g. "SOURCE — GITHUB". */
	sourceLabel: string;
	/** Number of items rendered in this card (post-filter if applicable). */
	count: number;
	/** Message shown when `count === 0` and no partial failure applies. */
	emptyMessage: string;
	/** Optional decorative icon rendered to the left of the title. */
	icon?: ReactNode;
	/** Optional partial-failure banner shown above the items. */
	partialFailure?: PartialFailure;
	/** The rendered list of items. */
	children?: ReactNode;
	className?: string;
}

export function SourceCard({
	title,
	sourceLabel,
	count,
	emptyMessage,
	icon,
	partialFailure,
	children,
	className,
}: SourceCardProps) {
	const isEmpty = count === 0;

	return (
		<section
			className={cn(
				"flex h-full flex-col rounded-2xl border border-border bg-card p-6",
				className,
			)}
			aria-labelledby={`source-card-${sourceLabel.replace(/\s+/g, "-").toLowerCase()}`}
		>
			<header className="flex items-start justify-between gap-4">
				<div className="min-w-0">
					<span className="editorial-label">{sourceLabel}</span>
					<h2
						id={`source-card-${sourceLabel.replace(/\s+/g, "-").toLowerCase()}`}
						className="mt-3 flex items-center gap-2 font-sans text-lg font-medium tracking-tight text-foreground"
					>
						{icon ? (
							<span
								aria-hidden="true"
								className="text-muted-foreground"
							>
								{icon}
							</span>
						) : null}
						<span className="truncate">{title}</span>
					</h2>
				</div>

				<span className="shrink-0 rounded-full border border-border bg-muted px-2.5 py-0.5 font-sans text-xs font-medium text-muted-foreground">
					<span className="sr-only">{count} items</span>
					<span aria-hidden="true">{count}</span>
				</span>
			</header>

			{partialFailure ? (
				<div
					role="alert"
					className="mt-4 flex items-start gap-2 rounded-md border border-highlight/40 bg-highlight/10 px-3 py-2 text-xs text-foreground/90"
				>
					<AlertTriangleIcon
						className="mt-0.5 size-3.5 shrink-0 text-highlight"
						aria-hidden="true"
					/>
					<div className="min-w-0">
						<p className="font-medium">Partial results</p>
						<p className="mt-0.5 text-muted-foreground">
							{partialFailure.reason}
						</p>
					</div>
				</div>
			) : null}

			<div className="mt-5 max-h-96 min-h-0 flex-1 overflow-y-auto pr-1">
				{isEmpty ? (
					<p className="text-sm text-muted-foreground">
						{emptyMessage}
					</p>
				) : (
					children
				)}
			</div>
		</section>
	);
}
