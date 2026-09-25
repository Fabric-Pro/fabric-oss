"use client";

import { Button } from "@ui/components/button";

type Props = {
	message: string;
	onRetry: () => void;
	className?: string;
};

/**
 * A failed read, said plainly, with a way to try again.
 *
 * Several prompt surfaces degrade a query failure into a confident, wrong
 * empty or fallback state instead of this (Fizzy #2249) — an empty prompt
 * library read as "no prompts yet", a failed catalog read as every action
 * running on its built-in default. This is the one place that copy and the
 * retry button live, so a surface that gets it right does not drift from one
 * that still needs fixing.
 */
export function LoadFailure({ message, onRetry, className }: Props) {
	return (
		<div
			className={className ?? "space-y-4 py-12 text-center"}
			role="alert"
		>
			<p className="text-muted-foreground text-sm">{message}</p>
			<Button variant="outline" onClick={onRetry}>
				Try again
			</Button>
		</div>
	);
}
