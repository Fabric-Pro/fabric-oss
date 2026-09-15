"use client";

/**
 * ReadinessPanel
 *
 * Checklist of readiness gates for a feature (plan §1.1 / Slice 5). Always
 * visible: each gap is listed with whether it blocks (enforcement flag on) or
 * is advisory (flag off). Shows a "Review required" badge when the project
 * routes stage changes through an approver.
 *
 * Editorial restraint: no ambient motion, tokens only, typography carries
 * the hierarchy.
 */

import { Badge } from "@ui/components/badge";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	AlertCircleIcon,
	CheckCircle2Icon,
	CircleDashedIcon,
	ShieldCheckIcon,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReadinessGap } from "../../lib/stories/readiness";
import { InfoTip } from "./InfoTip";
import { useStoryReadiness } from "./useStoryReadiness";

type Props = {
	projectId: string;
	storyId: string;
	organizationId?: string | null;
	/** Story version; bumping it refetches. */
	version?: number | null;
	className?: string;
	/** Viewer may change enforcement flags (PROJECT_GOVERNANCE_MANAGE). */
	canManageGovernance?: boolean;
	/** Settings › Engagement, offered in gap tooltips to governance managers. */
	settingsHref?: string;
};

export function ReadinessPanel({
	projectId,
	storyId,
	organizationId,
	version,
	className,
	canManageGovernance = false,
	settingsHref,
}: Props) {
	const t = useTranslations("projects.stories.readiness");
	const tTips = useTranslations("tooltips.stories");
	const { data, isPending, isError } = useStoryReadiness({
		projectId,
		storyId,
		organizationId,
		version,
	});

	if (isPending) {
		return (
			<section
				aria-label={t("title")}
				className={cn(
					"flex items-center gap-2 px-6 py-2 text-xs text-muted-foreground",
					className,
				)}
			>
				<CircleDashedIcon className="size-3.5" aria-hidden="true" />
				{t("loading")}
			</section>
		);
	}

	if (isError || !data) {
		// Fail closed in the UI too: an unknown state reads as not ready.
		return (
			<section
				aria-label={t("title")}
				className={cn(
					"flex items-center gap-2 px-6 py-2 text-xs text-destructive",
					className,
				)}
			>
				<AlertCircleIcon className="size-3.5" aria-hidden="true" />
				{t("gaps.EVIDENCE_UNAVAILABLE")}
			</section>
		);
	}

	const gaps: { code: ReadinessGap; blocks: boolean }[] = [
		...data.missing.map((code) => ({ code, blocks: true })),
		...data.advisory.map((code) => ({ code, blocks: false })),
	];
	const isDeferred = data.effectiveTrack === "DEFER";

	return (
		<section
			aria-label={t("title")}
			className={cn(
				"border-b bg-muted/40 px-6 py-2.5 text-xs",
				className,
			)}
		>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<span className="editorial-label inline-flex items-center gap-2 font-sans text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
					<span
						aria-hidden="true"
						className="inline-block h-3 w-px bg-primary"
					/>
					{t("title")}
					<InfoTip label={tTips("readinessHelp")}>
						<p>{tTips("readinessIntro")}</p>
						{canManageGovernance && settingsHref && (
							<p className="mt-1">{tTips("readinessManage")}</p>
						)}
					</InfoTip>
				</span>
				<span
					className={cn(
						"inline-flex items-center gap-1.5 font-medium",
						data.ready ? "text-secondary" : "text-foreground",
					)}
				>
					{data.ready ? (
						<CheckCircle2Icon
							className="size-3.5"
							aria-hidden="true"
						/>
					) : (
						<AlertCircleIcon
							className="size-3.5"
							aria-hidden="true"
						/>
					)}
					{isDeferred
						? t("deferred")
						: data.ready
							? t("ready")
							: t("notReady")}
				</span>
				<span className="text-muted-foreground">
					{t("trackLabel")}: {t(`tracks.${data.effectiveTrack}`)}
				</span>
				{data.reviewRequired && (
					<Badge
						variant="outline"
						className="gap-1 border-highlight/40 bg-highlight/10 text-highlight"
						title={t("reviewRequiredHint")}
					>
						<ShieldCheckIcon
							className="size-3"
							aria-hidden="true"
						/>
						{t("reviewRequired")}
					</Badge>
				)}
			</div>
			{gaps.length > 0 && (
				<ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
					{gaps.map(({ code, blocks }) => (
						<li key={code}>
							{/* Each gap says what unblocks it and whether the gate
							    is enforced or advisory on this project. */}
							<Tooltip>
								<TooltipTrigger asChild>
									<button
										type="button"
										className={cn(
											"inline-flex cursor-help items-center gap-1.5 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
											blocks
												? "text-foreground"
												: "text-muted-foreground",
										)}
									>
										<span
											aria-hidden="true"
											className={cn(
												"inline-block size-1.5 rounded-full",
												blocks
													? "bg-destructive"
													: "bg-highlight",
											)}
										/>
										{t(`gaps.${code}`)}
										<span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
											{blocks
												? t("blocks")
												: t("advisory")}
										</span>
									</button>
								</TooltipTrigger>
								<TooltipContent className="max-w-xs text-xs leading-5">
									<p>{tTips(`readinessGap.${code}`)}</p>
									<p className="mt-1 text-muted-foreground">
										{blocks
											? tTips("readinessEnforced")
											: tTips("readinessAdvisory")}
									</p>
									{canManageGovernance && settingsHref && (
										<p className="mt-1">
											<Link
												href={settingsHref}
												className="underline underline-offset-2"
											>
												{tTips("readinessManage")}
											</Link>
										</p>
									)}
								</TooltipContent>
							</Tooltip>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
