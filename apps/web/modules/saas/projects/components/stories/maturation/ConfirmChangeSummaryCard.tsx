"use client";

import { cn } from "@ui/lib";
import { ChevronDown, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

type Props = {
	/** Section-tagged bullets from `summarizeChanges`; null until resolved. */
	bullets: string[] | null;
	/** The summarize mutation is in flight. */
	isLoading: boolean;
	/**
	 * Optional: invoked when a bullet is clicked, with the bullet text. When
	 * provided, bullets render as buttons so the parent can scroll the diff to the
	 * referenced section and highlight it. Omit to render plain, non-interactive
	 * bullets.
	 */
	onBulletClick?: (bullet: string) => void;
};

/**
 * Confirm-time "Changes in this update" summary.
 * Sits directly above the inline diff-review bar. While the summarize call is in
 * flight it shows a compact "Summarizing changes…" line; when bullets are present
 * it lists them under an editorial-label heading.
 *
 * The header is a collapse toggle and the list is height-capped with its own
 * scroll, so a long summary never pushes the diff off-screen. It is purely
 * advisory — when the summary is empty or errored (bullets `[]`/`null` and not
 * loading) it renders nothing, so the diff bar stands alone and Accept / Reject
 * are never blocked.
 */
export function ConfirmChangeSummaryCard({
	bullets,
	isLoading,
	onBulletClick,
}: Props) {
	const t = useTranslations("projects.stories.maturation.confirmSummary");
	const [collapsed, setCollapsed] = useState(false);

	if (isLoading) {
		return (
			<div className="border-b border-border bg-muted/30 px-4 py-2">
				<p className="flex items-center gap-2 text-xs text-muted-foreground">
					<Loader2 className="size-3.5 animate-spin" />
					{t("loading")}
				</p>
			</div>
		);
	}

	if (!bullets || bullets.length === 0) {
		return null;
	}

	return (
		<div className="border-b border-border bg-muted/30 px-4 py-2">
			<button
				type="button"
				onClick={() => setCollapsed((c) => !c)}
				aria-expanded={!collapsed}
				className="flex w-full items-center gap-2 py-0.5 text-left"
			>
				<ChevronDown
					className={cn(
						"size-3.5 shrink-0 text-muted-foreground transition-transform",
						collapsed && "-rotate-90",
					)}
					aria-hidden="true"
				/>
				<h3 className="editorial-label text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
					{t("heading")}
				</h3>
				<span className="text-[11px] text-muted-foreground/70">
					{bullets.length}
				</span>
			</button>

			{!collapsed && (
				<ul className="mt-2 max-h-40 space-y-1 overflow-y-auto pr-1">
					{bullets.map((bullet) => {
						const dot = (
							<span
								aria-hidden="true"
								className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground/60"
							/>
						);
						return (
							<li key={bullet}>
								{onBulletClick ? (
									<button
										type="button"
										onClick={() => onBulletClick(bullet)}
										className="flex w-full gap-2 rounded text-left text-sm leading-snug text-foreground transition-colors hover:text-primary"
									>
										{dot}
										<span>{bullet}</span>
									</button>
								) : (
									<div className="flex gap-2 text-sm leading-snug text-foreground">
										{dot}
										<span>{bullet}</span>
									</div>
								)}
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}
