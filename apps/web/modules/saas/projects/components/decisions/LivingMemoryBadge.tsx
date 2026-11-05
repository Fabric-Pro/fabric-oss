"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { BookOpenTextIcon } from "lucide-react";
import { useTranslations } from "next-intl";

/**
 * `ArchitectureDecision.sourceKind` of a decision created from a Living Memory
 * candidate. Mirrors `LIVING_MEMORY_DECISION_SOURCE_KIND` in `@repo/database`,
 * which this client bundle does not import.
 */
export const LIVING_MEMORY_SOURCE_KIND = "living_memory";

/** The file a Living Memory decision was found in, read defensively. */
function livingMemorySourcePath(sourceMetadata: unknown): string | null {
	return sourceMetadata &&
		typeof sourceMetadata === "object" &&
		"sourcePath" in sourceMetadata &&
		typeof sourceMetadata.sourcePath === "string"
		? sourceMetadata.sourcePath
		: null;
}

/**
 * The "From Living Memory" marker beside "From meeting": a labelled pill in
 * the list, an icon in the dense table.
 */
export function LivingMemoryBadge({
	variant = "pill",
}: {
	variant?: "pill" | "icon";
}) {
	const t = useTranslations("projects.livingMemoryDecisions");
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				{variant === "pill" ? (
					<span className="relative z-10 inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/5 px-2 py-0.5 text-[11px] text-primary">
						<BookOpenTextIcon className="size-3" aria-hidden />
						{t("badge")}
					</span>
				) : (
					<span className="inline-flex">
						<BookOpenTextIcon
							className="size-3 text-primary"
							aria-label={t("badge")}
						/>
					</span>
				)}
			</TooltipTrigger>
			<TooltipContent surface="popover" className="max-w-56">
				<span className="font-medium">{t("badge")}</span>{" "}
				{t("badgeTooltip")}
			</TooltipContent>
		</Tooltip>
	);
}

/** The marker's row in the Decisions legend, beside "From meeting". */
export function LivingMemoryLegendItem() {
	const t = useTranslations("projects.livingMemoryDecisions");
	return (
		<li className="flex items-start gap-2">
			<BookOpenTextIcon
				className="mt-0.5 size-3.5 shrink-0 text-primary"
				aria-hidden
			/>
			<span className="text-muted-foreground">
				<span className="font-medium text-foreground">
					{t("badge")}
				</span>{" "}
				{t("legend")}
			</span>
		</li>
	);
}

/** The detail sheet's provenance line: the marker and the file's path. */
export function LivingMemorySourceNote({
	sourceMetadata,
	className,
}: {
	sourceMetadata: unknown;
	className?: string;
}) {
	const t = useTranslations("projects.livingMemoryDecisions");
	const path = livingMemorySourcePath(sourceMetadata);
	return (
		<span
			className={cn(
				"inline-flex min-w-0 items-center gap-1 text-primary",
				className,
			)}
		>
			<BookOpenTextIcon className="size-3 shrink-0" aria-hidden />
			{t("sourceNote")}
			{path && (
				<span className="truncate font-mono text-muted-foreground">
					{path}
				</span>
			)}
		</span>
	);
}
