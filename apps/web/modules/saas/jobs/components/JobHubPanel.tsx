"use client";

import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import { Skeleton } from "@ui/components/skeleton";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { useJobs } from "../hooks/use-jobs";
import { isJobRunning, sortJobsForPanel } from "../lib/format-job";
import { JobCard } from "./JobCard";
import { JobsEmptyState } from "./JobsEmptyState";

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

function Section({
	label,
	count,
	children,
}: {
	label: string;
	count: number;
	children: React.ReactNode;
}) {
	return (
		<section className="space-y-2">
			<h3 className="app-editorial-label">
				{label} · {count}
			</h3>
			<div className="space-y-2">{children}</div>
		</section>
	);
}

/**
 * The Job Hub — a slide-out panel listing this workspace's background jobs.
 *
 * A Sheet on every breakpoint (rather than the notification bell's
 * desktop-popover / mobile-sheet split): job entries carry counts and an
 * expandable step list, which a popover cannot hold without scrolling itself
 * into uselessness.
 */
export function JobHubPanel({ open, onOpenChange }: Props) {
	const t = useTranslations("app.jobs");
	const params = useParams<{ id?: string }>();
	const currentProjectId = params?.id ?? null;

	const { data, isPending } = useJobs(open);

	const { active, recent } = useMemo(() => {
		const jobs = sortJobsForPanel(data?.jobs ?? [], currentProjectId);
		return {
			active: jobs.filter(isJobRunning),
			recent: jobs.filter((job) => !isJobRunning(job)),
		};
	}, [data?.jobs, currentProjectId]);

	const isEmpty = active.length === 0 && recent.length === 0;

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				className="flex w-full flex-col border-l border-border bg-card p-6 motion-safe:transition-transform sm:max-w-lg"
			>
				<SheetHeader className="space-y-2">
					<span className="app-editorial-label">
						{t("sectionLabel")}
					</span>
					<SheetTitle className="font-serif font-normal text-2xl">
						{t("title")}
					</SheetTitle>
					<SheetDescription>{t("description")}</SheetDescription>
				</SheetHeader>

				<div className="subtle-scrollbar -mr-2 mt-4 flex-1 space-y-6 overflow-y-auto pr-2">
					{isPending ? (
						<div className="space-y-2">
							<Skeleton className="h-24 w-full" />
							<Skeleton className="h-24 w-full" />
						</div>
					) : isEmpty ? (
						<JobsEmptyState />
					) : (
						<>
							{active.length > 0 ? (
								<Section
									label={t("sections.active")}
									count={active.length}
								>
									{active.map((job) => (
										<JobCard key={job.id} job={job} />
									))}
								</Section>
							) : null}

							{recent.length > 0 ? (
								<Section
									label={t("sections.recent")}
									count={recent.length}
								>
									{recent.map((job) => (
										<JobCard key={job.id} job={job} />
									))}
								</Section>
							) : null}
						</>
					)}
				</div>

				{data?.retentionDays ? (
					<p className="mt-4 border-t border-border pt-3 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
						{t("retentionNote", { days: data.retentionDays })}
					</p>
				) : null}
			</SheetContent>
		</Sheet>
	);
}
