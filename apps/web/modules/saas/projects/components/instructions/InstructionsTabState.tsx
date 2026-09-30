"use client";

import { Button } from "@ui/components/button";
import { Skeleton } from "@ui/components/skeleton";
import { AlertTriangleIcon, RefreshCwIcon } from "lucide-react";
import { useTranslations } from "next-intl";

/**
 * What the Coding Instructions tab shows while its first reads are in flight:
 * the published tree's header and two columns, as grey blocks, so the tab does
 * not open as a blank panel and then jump. Announced once, politely, rather
 * than as a pile of unnamed blocks.
 */
export function InstructionsTabSkeleton() {
	const t = useTranslations("projects.codingInstructions.loadState");
	return (
		<output aria-busy="true" className="block space-y-4">
			<span className="sr-only">{t("loading")}</span>
			<div aria-hidden className="space-y-2">
				<Skeleton className="h-6 w-56" />
				<Skeleton className="h-4 w-80 max-w-full" />
			</div>
			<div aria-hidden className="grid gap-4 md:grid-cols-[16rem_1fr]">
				<Skeleton className="h-64 w-full" />
				<Skeleton className="h-64 w-full" />
			</div>
		</output>
	);
}

/**
 * The published version or the version list could not be read, and there is
 * nothing else to show. It must never read as "no instructions yet": the empty
 * state invites an upload, and a person who sees it over a failed read may
 * replace a published version they never saw.
 */
export function InstructionsLoadError({
	onRetry,
	retrying,
}: {
	onRetry: () => void;
	retrying: boolean;
}) {
	const t = useTranslations("projects.codingInstructions.loadState");
	return (
		<div
			role="alert"
			className="flex flex-col items-start gap-3 rounded-lg border bg-card p-6"
		>
			<div className="flex items-center gap-2">
				<AlertTriangleIcon
					aria-hidden
					className="size-4 text-destructive"
				/>
				<p className="font-medium text-sm">{t("errorTitle")}</p>
			</div>
			<p className="text-muted-foreground text-sm">{t("errorBody")}</p>
			<Button
				type="button"
				variant="outline"
				size="sm"
				aria-busy={retrying}
				disabled={retrying}
				onClick={onRetry}
			>
				<RefreshCwIcon aria-hidden className="mr-2 size-4" />
				{t("retry")}
			</Button>
		</div>
	);
}
