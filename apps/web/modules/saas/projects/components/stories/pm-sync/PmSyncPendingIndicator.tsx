"use client";

import { cn } from "@ui/lib";

type Props = {
	className?: string;
	pmToolName?: string;
};

export function PmSyncPendingIndicator({ className, pmToolName }: Props) {
	const label = pmToolName ? `Syncing to ${pmToolName}…` : "Syncing to PM…";
	return (
		<output
			aria-live="polite"
			className={cn(
				"inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-muted px-2 py-0.5",
				"text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground",
				"motion-safe:animate-pulse",
				className,
			)}
		>
			<span
				aria-hidden="true"
				className="size-1.5 rounded-full bg-muted-foreground/60"
			/>
			{label}
		</output>
	);
}
