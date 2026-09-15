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
import { SparklesIcon, UserIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { orpcClient } from "../../../../shared/lib/orpc-client";
import {
	ASSIGNABLE_DELIVERY_TRACKS,
	DELIVERY_TRACK_META,
	DELIVERY_TRACK_TONE_CLASSES,
	type DeliveryTrack,
	type TrackSetBy,
} from "../../lib/stories/types";
import { InfoTip } from "./InfoTip";

interface Props {
	projectId: string;
	storyId: string;
	track: DeliveryTrack;
	rationale?: string | null;
	setBy?: TrackSetBy | null;
	disabled?: boolean;
	/** Called after a successful save with the new track. */
	onChanged?: (track: DeliveryTrack) => void;
	className?: string;
}

/**
 * Delivery-track picker for the feature workspace.
 *
 * Shows the four assignable tracks, the rationale beneath, and whether the
 * current value came from the classifier (AI) or a person. Saving marks the
 * track as human-set so the classifier will not overwrite it.
 */
export function DeliveryTrackSelector({
	projectId,
	storyId,
	track,
	rationale,
	setBy,
	disabled,
	onChanged,
	className,
}: Props) {
	const t = useTranslations("projects.stories.deliveryTrack");
	const tTips = useTranslations("tooltips.stories");
	const { organizationId } = useOrganizationContext();
	const queryClient = useQueryClient();

	const mutation = useMutation({
		mutationFn: async (next: DeliveryTrack) => {
			if (next === "UNCLASSIFIED") {
				throw new Error("UNCLASSIFIED cannot be assigned");
			}
			return await orpcClient.projects.stories.setDeliveryTrack({
				projectId,
				storyId,
				organizationId: organizationId ?? null,
				track: next,
			});
		},
		onSuccess: (_data, next) => {
			void queryClient.invalidateQueries({
				queryKey: ["projects", "stories"],
			});
			toast.success(
				t("saved", { track: DELIVERY_TRACK_META[next].label }),
			);
			onChanged?.(next);
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : t("saveFailed"),
			);
		},
	});

	const meta = DELIVERY_TRACK_META[track] ?? DELIVERY_TRACK_META.UNCLASSIFIED;
	const tone = DELIVERY_TRACK_TONE_CLASSES[meta.tone];
	const selectValue = track === "UNCLASSIFIED" ? undefined : track;

	return (
		<div className={cn("space-y-2", className)}>
			<div className="flex items-center justify-between gap-2">
				<span className="inline-flex items-center gap-1.5">
					<Label htmlFor="delivery-track">{t("label")}</Label>
					<InfoTip label={tTips("trackHelp")}>
						<p>{tTips("trackIntro")}</p>
						{ASSIGNABLE_DELIVERY_TRACKS.map((option) => (
							<p key={option} className="mt-1">
								{tTips(`track.${option}`)}
							</p>
						))}
					</InfoTip>
				</span>
				{setBy ? (
					<span
						className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground"
						data-testid="delivery-track-set-by"
					>
						{setBy === "AI" ? (
							<SparklesIcon
								className="size-3"
								aria-hidden="true"
							/>
						) : (
							<UserIcon className="size-3" aria-hidden="true" />
						)}
						{setBy === "AI" ? t("setBy.ai") : t("setBy.human")}
					</span>
				) : null}
			</div>
			<Select
				value={selectValue}
				onValueChange={(v) => mutation.mutate(v as DeliveryTrack)}
				disabled={disabled || mutation.isPending}
			>
				<SelectTrigger id="delivery-track" aria-label={t("label")}>
					<SelectValue placeholder={t("placeholder")}>
						{selectValue ? (
							<span className="flex items-center gap-2">
								<span
									className={cn(
										"size-2 rounded-full",
										tone.dot,
									)}
									aria-hidden="true"
								/>
								{meta.label}
							</span>
						) : undefined}
					</SelectValue>
				</SelectTrigger>
				<SelectContent>
					{ASSIGNABLE_DELIVERY_TRACKS.map((option) => {
						const optionMeta = DELIVERY_TRACK_META[option];
						const optionTone =
							DELIVERY_TRACK_TONE_CLASSES[optionMeta.tone];
						return (
							<SelectItem key={option} value={option}>
								<span className="flex items-center gap-2">
									<span
										className={cn(
											"size-2 rounded-full",
											optionTone.dot,
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
				data-testid="delivery-track-rationale"
			>
				{rationale?.trim() ? rationale : meta.description}
			</p>
		</div>
	);
}
