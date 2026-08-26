"use client";

import { Sparkles } from "lucide-react";
import type { ContextCompactionEvent } from "../../hooks/useOrchestratorStream";

interface Props {
	compactions: ContextCompactionEvent[];
}

export function ContextCompactionNotice({ compactions }: Props) {
	if (compactions.length === 0) {
		return null;
	}

	const totalTurnsCompacted = compactions.reduce(
		(sum, c) => sum + c.compactedTurns,
		0,
	);

	const detail =
		compactions.length === 1
			? `${totalTurnsCompacted} earlier turn${totalTurnsCompacted === 1 ? "" : "s"} folded into a summary`
			: `${compactions.length} compactions · ${totalTurnsCompacted} earlier turns folded into summaries`;

	return (
		<output className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
			<Sparkles
				className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-500"
				aria-hidden="true"
			/>
			<span className="flex-1 min-w-0 truncate">
				Compressed earlier context to keep going — {detail}.
			</span>
		</output>
	);
}
