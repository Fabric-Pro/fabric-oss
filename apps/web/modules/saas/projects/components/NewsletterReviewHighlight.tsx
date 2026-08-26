"use client";

import { Checkbox } from "@ui/components/checkbox";

/**
 * One highlight in the Release Notes review list.
 *
 * Extracted from `ProjectNewsletterSettings` (~1600 lines) for two reasons: the
 * panel cannot be mounted in a unit test at a sane cost, so without a seam this
 * behaviour is untestable, and the row genuinely owns one job — draw an item,
 * raise one event. It holds no state; the panel keeps owning the removed set.
 *
 * The excluded state deliberately does NOT use `line-through`. Strikethrough
 * reads as "deleted", and reviewers took it to mean the feature was being
 * dropped rather than left out of this one issue (Fizzy #2172).
 */
export function NewsletterReviewHighlight({
	title,
	description,
	excluded,
	onToggle,
}: {
	title: string;
	description: string;
	excluded: boolean;
	onToggle: () => void;
}) {
	return (
		<li className="flex items-start gap-2">
			<Checkbox
				checked={!excluded}
				onCheckedChange={onToggle}
				aria-label={`Include ${title}`}
				className="mt-0.5"
			/>
			<span
				className={
					excluded
						? "text-muted-foreground text-sm"
						: "text-foreground text-sm"
				}
			>
				<strong>{title}</strong> — {description}
				{excluded ? (
					// aria-hidden: the checkbox already announces the state, and
					// hearing it twice makes the row read as two controls that
					// disagree.
					<span
						aria-hidden="true"
						className="ml-2 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground uppercase tracking-[0.1em]"
					>
						Excluded
					</span>
				) : null}
			</span>
		</li>
	);
}
