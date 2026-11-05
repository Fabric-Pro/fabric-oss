"use client";

import { Button } from "@ui/components/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import { AlertCircle, ChevronDown, Loader2, Wrench } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

/** Completed activity stays out of the answer; failures remain visible in its summary. */
export function ResponseActivity({
	statuses,
	children,
}: {
	statuses: readonly string[];
	children: ReactNode;
}) {
	const t = useTranslations("genieExperience");
	if (!statuses.length) {
		return null;
	}
	const working = statuses.filter(
		(status) => status === "pending" || status === "running",
	).length;
	const failed = statuses.filter((status) => status === "error").length;
	return (
		<Collapsible className="group/activity">
			<CollapsibleTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-auto max-w-full flex-wrap justify-start gap-2 text-muted-foreground"
				>
					{working ? (
						<Loader2
							className="size-3.5 motion-safe:animate-spin"
							aria-hidden
						/>
					) : failed ? (
						<AlertCircle
							className="size-3.5 text-destructive"
							aria-hidden
						/>
					) : (
						<Wrench className="size-3.5" aria-hidden />
					)}
					<span>{t("activity", { count: statuses.length })}</span>
					{working > 0 && (
						<span>{t("workingActions", { count: working })}</span>
					)}
					{failed > 0 && (
						<span className="text-destructive">
							{t("failedActions", { count: failed })}
						</span>
					)}
					{!working && !failed && (
						<span>
							{t("completedActions", { count: statuses.length })}
						</span>
					)}
					<ChevronDown
						className="size-3.5 transition-transform group-data-[state=open]/activity:rotate-180"
						aria-hidden
					/>
				</Button>
			</CollapsibleTrigger>
			<CollapsibleContent className="space-y-2 pt-2">
				{children}
			</CollapsibleContent>
		</Collapsible>
	);
}
