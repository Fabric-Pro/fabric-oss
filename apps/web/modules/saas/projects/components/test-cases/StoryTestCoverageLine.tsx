"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { ClipboardCheckIcon, Loader2Icon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
	RESULT_I18N_KEY,
	STATE_I18N_KEY,
	type TestCaseState,
	type TestResult,
} from "./constants";

type Props = {
	projectId: string;
	storyId: string;
	organizationId: string | null;
	className?: string;
};

/**
 * Low-visibility "tested by" indicator on a feature/bug (R5): just a clipboard
 * icon + the linked-case count, with the description on a hover tooltip. Renders
 * nothing while loading or when no cases cover the story, so an uncovered work
 * item stays clean. Clicking opens a small popover listing the covering cases,
 * each a deep-link into the QA tab (the only reverse-navigation from a
 * work item to its cases). Counts stay cheap (`coverageForStory`); the case list
 * is fetched lazily, only once the popover opens.
 */
export function StoryTestCoverageLine({
	projectId,
	storyId,
	organizationId,
	className,
}: Props) {
	const t = useTranslations("projects.testCases");
	const pathname = usePathname();
	const [open, setOpen] = useState(false);

	const { data } = useQuery(
		orpc.projects.testCases.coverageForStory.queryOptions({
			input: { projectId, storyId, organizationId },
		}),
	);
	const count = data?.count ?? 0;

	// Lazy: only load the covering cases once the popover is opened.
	const { data: listData, isLoading: listLoading } = useQuery({
		...orpc.projects.testCases.list.queryOptions({
			input: {
				projectId,
				organizationId,
				linkedStoryId: storyId,
				limit: 50,
			},
		}),
		enabled: open && count > 0,
	});
	const cases = listData?.items ?? [];

	if (count <= 0) {
		return null;
	}

	// `.../projects/{id}/stories/{storyId}` → `.../projects/{id}` so each case
	// deep-links to the QA tab with that case pre-opened.
	const projectBase = pathname.replace(/\/stories\/[^/]+.*$/, "");

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<Tooltip>
				<TooltipTrigger asChild>
					<PopoverTrigger asChild>
						<button
							type="button"
							aria-label={t("coverage", { count })}
							className={cn(
								"inline-flex items-center gap-1 rounded-full border border-secondary/30 bg-secondary/10 px-1.5 py-0.5 text-muted-foreground text-xs tabular-nums transition-colors hover:bg-secondary/20 hover:text-foreground",
								className,
							)}
						>
							<ClipboardCheckIcon
								className="size-3"
								aria-hidden="true"
							/>
							{count}
						</button>
					</PopoverTrigger>
				</TooltipTrigger>
				<TooltipContent>{t("coverage", { count })}</TooltipContent>
			</Tooltip>
			<PopoverContent align="start" className="w-72 p-0">
				<div className="border-b px-3 py-2 font-medium text-sm">
					{t("coverage", { count })}
				</div>
				<div className="max-h-72 overflow-y-auto py-1">
					{listLoading ? (
						<div className="flex items-center justify-center py-6 text-muted-foreground">
							<Loader2Icon className="size-4 animate-spin" />
						</div>
					) : (
						cases.map((c) => (
							<Link
								key={c.id}
								href={`${projectBase}?tab=test-cases&case=${c.id}`}
								className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent"
								onClick={() => setOpen(false)}
							>
								<span className="shrink-0 font-mono text-muted-foreground text-xs">
									{c.identifier}
								</span>
								<span className="min-w-0 flex-1 truncate">
									{c.title}
								</span>
								<span className="shrink-0 text-muted-foreground text-xs">
									{c.currentResult &&
									c.currentResult !== "NOT_RUN"
										? t(
												RESULT_I18N_KEY[
													c.currentResult as TestResult
												],
											)
										: t(
												STATE_I18N_KEY[
													c.state as TestCaseState
												],
											)}
								</span>
							</Link>
						))
					)}
				</div>
			</PopoverContent>
		</Popover>
	);
}
