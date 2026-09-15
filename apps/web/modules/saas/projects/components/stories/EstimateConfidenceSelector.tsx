"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { cn } from "@ui/lib";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { orpcClient } from "../../../../shared/lib/orpc-client";
import {
	type DeliveryTrack,
	ESTIMATE_CONFIDENCE_META,
	ESTIMATE_CONFIDENCE_ORDER,
	type EstimateConfidence,
} from "../../lib/stories/types";
import { InfoTip } from "./InfoTip";

interface Props {
	projectId: string;
	storyId: string;
	confidence: EstimateConfidence | null;
	deliveryTrack: DeliveryTrack;
	disabled?: boolean;
	/** Called after a successful save with the persisted confidence. */
	onChanged?: (confidence: EstimateConfidence) => void;
	className?: string;
}

/**
 * Estimate-confidence picker for the feature workspace (plan Slice 7).
 *
 * Calls `projects.stories.setEstimate`. The server forces LOW on a SPIKE
 * that has no accepted spike run; when that happens the response carries
 * `forcedLowConfidence` and the picker explains it instead of pretending
 * the requested value stuck.
 */
export function EstimateConfidenceSelector({
	projectId,
	storyId,
	confidence,
	deliveryTrack,
	disabled,
	onChanged,
	className,
}: Props) {
	const t = useTranslations("projects.stories.estimateConfidence");
	const tTips = useTranslations("tooltips.stories");
	const { organizationId } = useOrganizationContext();
	const queryClient = useQueryClient();

	const mutation = useMutation({
		mutationFn: async (next: EstimateConfidence) => {
			return await orpcClient.projects.stories.setEstimate({
				projectId,
				storyId,
				organizationId: organizationId ?? null,
				estimateConfidence: next,
			});
		},
		onSuccess: (result, requested) => {
			void queryClient.invalidateQueries({
				queryKey: ["projects", "stories"],
			});
			const persisted =
				(result.story
					.estimateConfidence as EstimateConfidence | null) ??
				requested;
			if (result.forcedLowConfidence && requested !== "LOW") {
				toast.info(t("forcedLow"));
			} else {
				toast.success(
					t("saved", {
						confidence: ESTIMATE_CONFIDENCE_META[persisted].label,
					}),
				);
			}
			onChanged?.(persisted);
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : t("saveFailed"),
			);
		},
	});

	const meta = confidence ? ESTIMATE_CONFIDENCE_META[confidence] : null;

	return (
		<div className={cn("space-y-2", className)}>
			<span className="inline-flex items-center gap-1.5">
				<Label htmlFor="estimate-confidence">{t("label")}</Label>
				<InfoTip label={tTips("confidenceHelp")}>
					<p>{tTips("confidenceIntro")}</p>
					{ESTIMATE_CONFIDENCE_ORDER.map((option) => (
						<p key={option} className="mt-1">
							{tTips(`confidence.${option}`)}
						</p>
					))}
					{deliveryTrack === "SPIKE" && (
						<p className="mt-1">{tTips("confidenceSpikeLock")}</p>
					)}
				</InfoTip>
			</span>
			<Select
				value={confidence ?? undefined}
				onValueChange={(v) => mutation.mutate(v as EstimateConfidence)}
				disabled={disabled || mutation.isPending}
			>
				<SelectTrigger id="estimate-confidence" aria-label={t("label")}>
					<SelectValue placeholder={t("placeholder")}>
						{meta ? (
							<span className="flex items-center gap-2">
								<span
									className={cn(
										"size-2 rounded-full",
										meta.dotClass,
									)}
									aria-hidden="true"
								/>
								{meta.label}
							</span>
						) : undefined}
					</SelectValue>
				</SelectTrigger>
				<SelectContent>
					{ESTIMATE_CONFIDENCE_ORDER.map((option) => {
						const optionMeta = ESTIMATE_CONFIDENCE_META[option];
						return (
							<SelectItem key={option} value={option}>
								<span className="flex items-center gap-2">
									<span
										className={cn(
											"size-2 rounded-full",
											optionMeta.dotClass,
										)}
										aria-hidden="true"
									/>
									{optionMeta.label}
								</span>
							</SelectItem>
						);
					})}
				</SelectContent>
			</Select>
			<p
				className="text-xs leading-relaxed text-muted-foreground"
				data-testid="estimate-confidence-hint"
			>
				{deliveryTrack === "SPIKE"
					? t("spikeHint")
					: (meta?.description ?? t("description"))}
			</p>
		</div>
	);
}
