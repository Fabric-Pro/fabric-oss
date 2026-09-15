"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { cn } from "@ui/lib";
import { FrameIcon, Loader2Icon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import {
	ACTIVE_SPIKE_STATUSES,
	asSpikeRunView,
	framesForStoryQueryKey,
	listFramesForStory,
	type SpikeRunView,
} from "../../lib/spike-runs";
import { SpikeRunCard } from "../coding-runs/SpikeRunCard";
import { InfoTip } from "./InfoTip";

type Props = {
	projectId: string;
	storyId: string;
	organizationId?: string | null;
	className?: string;
};

/**
 * Evidence section for a feature (inverted-loop plan, Slice 3): the spike
 * runs recorded against the story and the project frames (spike demos) the
 * agent produced for it. Renders nothing when there is no evidence yet so the
 * workspace stays quiet for SPECIFY features.
 */
export function StoryEvidence({
	projectId,
	storyId,
	organizationId: organizationIdProp,
	className,
}: Props) {
	const t = useTranslations("projects.stories.spike.evidence");
	const tTips = useTranslations("tooltips.stories");
	const { organizationId: contextOrganizationId, basePath } =
		useOrganizationContext();
	const organizationId =
		organizationIdProp === undefined
			? contextOrganizationId
			: organizationIdProp;

	const runsQuery = useQuery({
		...orpc.codingRuns.list.queryOptions({
			input: { storyId, organizationId: organizationId ?? null },
		}),
		refetchInterval: (query) => {
			const rows = (query.state.data ?? []) as unknown[];
			const hasActiveSpike = rows.some((row) => {
				const view = asSpikeRunView(row);
				return (
					view?.kind === "SPIKE" &&
					ACTIVE_SPIKE_STATUSES.includes(view.status) &&
					view.status !== "DEMO_READY"
				);
			});
			return hasActiveSpike ? 5000 : false;
		},
	});

	const framesQuery = useQuery({
		queryKey: framesForStoryQueryKey({
			projectId,
			storyId,
			organizationId: organizationId ?? null,
		}),
		queryFn: () =>
			listFramesForStory({
				projectId,
				storyId,
				organizationId: organizationId ?? null,
			}),
		staleTime: 15_000,
	});

	const spikeRuns = useMemo<SpikeRunView[]>(() => {
		const rows = (runsQuery.data ?? []) as unknown[];
		return rows
			.map(asSpikeRunView)
			.filter(
				(run): run is SpikeRunView =>
					run !== null &&
					run.kind === "SPIKE" &&
					(run.storyId === null || run.storyId === storyId),
			);
	}, [runsQuery.data, storyId]);

	const frames = framesQuery.data ?? [];
	const isLoading = runsQuery.isPending || framesQuery.isPending;
	const hasEvidence = spikeRuns.length > 0 || frames.length > 0;

	if (!isLoading && !hasEvidence) {
		return null;
	}

	return (
		<section
			className={cn("space-y-4", className)}
			aria-labelledby="story-evidence-heading"
			data-testid="story-evidence"
		>
			<div className="space-y-1">
				<p
					className="editorial-label inline-flex items-center gap-1.5"
					id="story-evidence-heading"
				>
					{t("title")}
					<InfoTip label={tTips("spikeEvidenceHelp")}>
						<p>{tTips("spikeEvidence")}</p>
						<p className="mt-1">{tTips("spikeRun")}</p>
						<p className="mt-1">{tTips("spikeAccept")}</p>
					</InfoTip>
				</p>
				<p className="text-xs leading-5 text-muted-foreground">
					{t("description")}
				</p>
			</div>

			{isLoading && !hasEvidence ? (
				<p className="flex items-center gap-2 text-sm text-muted-foreground">
					<Loader2Icon className="size-3.5 motion-safe:animate-spin" />
					{t("loading")}
				</p>
			) : null}

			{spikeRuns.length > 0 && (
				<div className="space-y-3">
					<p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
						{t("spikeRuns", { count: spikeRuns.length })}
					</p>
					<ul className="space-y-3">
						{spikeRuns.map((run) => (
							<li key={run.id}>
								<SpikeRunCard
									run={run}
									projectId={projectId}
									storyId={storyId}
									compact
								/>
							</li>
						))}
					</ul>
				</div>
			)}

			{frames.length > 0 && (
				<div className="space-y-3">
					<p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
						{t("frames", { count: frames.length })}
					</p>
					<ul className="divide-y divide-border/50 rounded-2xl border border-border/60 bg-card">
						{frames.map((frame) => (
							<li key={frame.id}>
								<Link
									href={`${basePath}/frames/${frame.id}`}
									className="flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"
								>
									<span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
										<FrameIcon className="size-4" />
									</span>
									<span className="min-w-0 flex-1">
										<span className="block truncate font-medium text-foreground">
											{frame.title}
										</span>
										{frame.description ? (
											<span className="block truncate text-xs text-muted-foreground">
												{frame.description}
											</span>
										) : null}
									</span>
									<Badge
										variant="outline"
										className="rounded-full px-2 py-0 text-[10px]"
									>
										{frame.kind === "slideshow"
											? t("slideshow")
											: t("frame")}
									</Badge>
								</Link>
							</li>
						))}
					</ul>
				</div>
			)}
		</section>
	);
}
