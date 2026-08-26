"use client";

import type { TestingVerdict } from "@saas/projects/lib/stories/testing-verdict";
import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import {
	CircleCheckIcon,
	CircleHelpIcon,
	CircleXIcon,
	RefreshCwIcon,
	SparklesIcon,
	TriangleAlertIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";

const LEVEL_STYLE = {
	blocked: {
		Icon: CircleXIcon,
		card: "border-destructive/35 bg-destructive/[0.06]",
		icon: "text-destructive",
	},
	caution: {
		Icon: TriangleAlertIcon,
		card: "border-highlight/35 bg-highlight/[0.07]",
		icon: "text-highlight",
	},
	ready: {
		Icon: CircleCheckIcon,
		card: "border-secondary/35 bg-secondary/[0.06]",
		icon: "text-secondary",
	},
	unknown: {
		Icon: CircleHelpIcon,
		card: "border-border bg-muted/50",
		icon: "text-muted-foreground",
	},
} as const;

type Props = {
	verdict: TestingVerdict;
	/** Re-run the analysis against the current specification. */
	onRefreshAnalysis?: () => void;
	/** Draft cases for the criteria that have none. */
	onDraftGaps?: () => void;
	refreshPending?: boolean;
	draftPending?: boolean;
	draftDisabledReason?: string;
};

/**
 * The answer, above the evidence.
 *
 * Everything this states is already derivable from the sections below — which
 * is the problem it solves. Assembling "can I sign this off" from a warnings
 * list, a matrix, a case table and a timestamp is work the page can do once,
 * and doing it by hand is how a feature gets signed off against an analysis
 * that predates its own specification.
 *
 * The actions are the ones that change the verdict, not a generic toolbar:
 * refresh the stale analysis, draft the missing cases.
 */
export function TestingVerdictCard({
	verdict,
	onRefreshAnalysis,
	onDraftGaps,
	refreshPending = false,
	draftPending = false,
	draftDisabledReason,
}: Props) {
	const t = useTranslations("projects.stories.maturation.qa.verdict");
	const style = LEVEL_STYLE[verdict.level];
	const { Icon } = style;

	const uncovered = verdict.reasons.find((r) => r.key === "uncovered");
	const showRefresh =
		onRefreshAnalysis !== undefined &&
		verdict.reasons.some((r) => r.key === "stale" || r.key === "missing");
	const showDraft = onDraftGaps !== undefined && uncovered !== undefined;

	return (
		<section
			aria-labelledby="testing-verdict-heading"
			className={cn("rounded-xl border p-4", style.card)}
		>
			<div className="flex items-start gap-3">
				<Icon
					aria-hidden="true"
					className={cn("mt-0.5 size-5 shrink-0", style.icon)}
				/>
				<div className="min-w-0 flex-1">
					<h3
						id="testing-verdict-heading"
						className="font-semibold text-base"
					>
						{t(`headline.${verdict.headlineKey}`)}
					</h3>

					{verdict.reasons.length > 0 && (
						<ul className="mt-1.5 space-y-0.5 text-sm leading-relaxed text-foreground/85">
							{verdict.reasons.map((reason) => (
								<li key={reason.key}>
									{t(`reason.${reason.key}`, {
										count: reason.count,
									})}
								</li>
							))}
						</ul>
					)}

					{(showRefresh || showDraft) && (
						<div className="mt-3 flex flex-wrap gap-2">
							{showRefresh && (
								<Button
									type="button"
									size="sm"
									onClick={onRefreshAnalysis}
									disabled={refreshPending}
								>
									<RefreshCwIcon
										aria-hidden="true"
										className={cn(
											"mr-2 size-3.5",
											refreshPending &&
												"motion-safe:animate-spin",
										)}
									/>
									{t("actions.refreshAnalysis")}
								</Button>
							)}
							{showDraft && (
								<Button
									type="button"
									size="sm"
									variant="outline"
									onClick={onDraftGaps}
									disabled={
										draftPending ||
										draftDisabledReason !== undefined
									}
									title={draftDisabledReason}
								>
									<SparklesIcon
										aria-hidden="true"
										className="mr-2 size-3.5"
									/>
									{t("actions.draftGaps", {
										count: uncovered.count,
									})}
								</Button>
							)}
						</div>
					)}
				</div>
			</div>
		</section>
	);
}
