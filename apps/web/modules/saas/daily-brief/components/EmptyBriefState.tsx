"use client";

/**
 * EmptyBriefState — shown when the brief completes successfully but there is
 * no activity in the selected window (status = EMPTY).
 */

import { Button } from "@ui/components/button";
import { RefreshCwIcon } from "lucide-react";

export interface EmptyBriefStateProps {
	/** Optional regenerate handler. */
	onRegenerate?: () => void;
}

export function EmptyBriefState({ onRegenerate }: EmptyBriefStateProps) {
	return (
		<div className="relative overflow-hidden rounded-2xl border border-border bg-card p-12 text-center">
			<div
				className="pointer-events-none absolute inset-0 opacity-40"
				style={{
					backgroundImage:
						"radial-gradient(circle, rgba(0,0,0,0.13) 1px, transparent 1px)",
					backgroundSize: "32px 32px",
				}}
				aria-hidden="true"
			/>
			<div className="relative">
				<span className="editorial-label">No activity</span>
				<h2 className="mt-4 font-serif text-3xl font-normal leading-tight text-foreground">
					Nothing new to brief on
				</h2>
				<p className="mx-auto mt-3 max-w-md text-sm leading-6 text-muted-foreground">
					There was no tracked activity on this project across the
					selected time window. Try widening the window, or check back
					after some work lands.
				</p>
				{onRegenerate ? (
					<div className="mt-6">
						<Button
							variant="editorial-ghost"
							onClick={onRegenerate}
						>
							<RefreshCwIcon
								className="size-3.5"
								aria-hidden="true"
							/>
							Regenerate
						</Button>
					</div>
				) : null}
			</div>
		</div>
	);
}
