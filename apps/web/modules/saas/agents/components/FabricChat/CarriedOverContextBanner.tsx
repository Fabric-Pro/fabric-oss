"use client";

import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import { formatDistanceToNow } from "date-fns";
import { ChevronDown, History } from "lucide-react";
import { useState } from "react";

interface Props {
	summary: string;
	carriedOverAt?: Date | string | null;
}

function describeCarriedOverAt(
	value: Date | string | null | undefined,
): string {
	if (!value) {
		return "an earlier session";
	}
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) {
		return "an earlier session";
	}
	return formatDistanceToNow(date, { addSuffix: true });
}

export function CarriedOverContextBanner({ summary, carriedOverAt }: Props) {
	const [open, setOpen] = useState(false);
	const wordCount = summary.trim().split(/\s+/).length;

	return (
		<div className="rounded-lg border border-border/60 bg-muted/40 px-3 py-2 mb-3">
			<Collapsible open={open} onOpenChange={setOpen}>
				<CollapsibleTrigger asChild>
					<button
						type="button"
						className="flex w-full items-center gap-2 text-left"
					>
						<History
							className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
							aria-hidden="true"
						/>
						<span className="text-xs text-muted-foreground flex-1 min-w-0 truncate">
							Continued from{" "}
							{describeCarriedOverAt(carriedOverAt)} — summary
							attached (~{wordCount} words)
						</span>
						<ChevronDown
							className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${
								open ? "rotate-180" : ""
							}`}
							aria-hidden="true"
						/>
					</button>
				</CollapsibleTrigger>
				<CollapsibleContent>
					<div className="mt-2 rounded-md border border-border/40 bg-background/60 p-3 text-xs text-foreground whitespace-pre-wrap max-h-72 overflow-y-auto">
						{summary}
					</div>
				</CollapsibleContent>
			</Collapsible>
		</div>
	);
}
