"use client";

import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Textarea } from "@ui/components/textarea";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { InfoTip } from "../stories/InfoTip";

interface VisionValues {
	visionPurpose: string;
	visionCoreActions: string[];
	visionCycle: string;
}

interface VisionFieldsProps extends VisionValues {
	onChange: (updates: Partial<VisionValues>) => void;
	disabled?: boolean;
	/** Hide the section heading when the parent renders its own. */
	hideHeading?: boolean;
}

export function parseCoreActions(raw: string): string[] {
	return raw
		.split(",")
		.map((action) => action.trim())
		.filter((action) => action.length > 0);
}

/**
 * Optional vision fields (plan §1.4): purpose, core actions, cycle. Shown for
 * EXPLORE and PROPOSAL. No gate depends on them; they feed classifier and
 * spike prompts and the outcomes page.
 */
export function VisionFields({
	visionPurpose,
	visionCoreActions,
	visionCycle,
	onChange,
	disabled = false,
	hideHeading = false,
}: VisionFieldsProps) {
	const t = useTranslations("projects.engagement.vision");
	const tTips = useTranslations("tooltips.projectSetup");
	const id = useId();

	// Core actions are edited as comma-separated text. Keep local text so a
	// trailing comma or space survives re-renders; sync from props only when
	// the parsed value actually differs (e.g. hydration from the server).
	const [coreActionsText, setCoreActionsText] = useState(() =>
		visionCoreActions.join(", "),
	);
	useEffect(() => {
		const fromProps = visionCoreActions.join(", ");
		if (parseCoreActions(coreActionsText).join(", ") !== fromProps) {
			setCoreActionsText(fromProps);
		}
		// Only react to prop changes; local typing is handled by the input.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [visionCoreActions]);

	return (
		<div className="space-y-5">
			{!hideHeading && (
				<div>
					<p className="text-base font-medium text-foreground">
						{t("title")}
					</p>
					<p className="mt-1 text-sm text-muted-foreground">
						{t("description")}
					</p>
				</div>
			)}

			<div className="space-y-2">
				<span className="inline-flex items-center gap-1.5">
					<Label htmlFor={`${id}-purpose`}>{t("purpose")}</Label>
					<InfoTip
						label={tTips("visionHelp", { field: t("purpose") })}
					>
						{tTips("visionPurpose")}
					</InfoTip>
				</span>
				<Textarea
					id={`${id}-purpose`}
					value={visionPurpose}
					onChange={(event) =>
						onChange({ visionPurpose: event.target.value })
					}
					placeholder={t("purposePlaceholder")}
					rows={3}
					maxLength={5000}
					disabled={disabled}
					className="resize-y"
				/>
			</div>

			<div className="space-y-2">
				<span className="inline-flex items-center gap-1.5">
					<Label htmlFor={`${id}-actions`}>{t("coreActions")}</Label>
					<InfoTip
						label={tTips("visionHelp", { field: t("coreActions") })}
					>
						{tTips("visionCoreActions")}
					</InfoTip>
				</span>
				<Input
					id={`${id}-actions`}
					value={coreActionsText}
					onChange={(event) => {
						setCoreActionsText(event.target.value);
						onChange({
							visionCoreActions: parseCoreActions(
								event.target.value,
							),
						});
					}}
					placeholder={t("coreActionsPlaceholder")}
					disabled={disabled}
					aria-describedby={`${id}-actions-hint`}
				/>
				<p
					id={`${id}-actions-hint`}
					className="text-xs text-muted-foreground"
				>
					{t("coreActionsHint")}
				</p>
			</div>

			<div className="space-y-2">
				<span className="inline-flex items-center gap-1.5">
					<Label htmlFor={`${id}-cycle`}>{t("cycle")}</Label>
					<InfoTip label={tTips("visionHelp", { field: t("cycle") })}>
						{tTips("visionCycle")}
					</InfoTip>
				</span>
				<Input
					id={`${id}-cycle`}
					value={visionCycle}
					onChange={(event) =>
						onChange({ visionCycle: event.target.value })
					}
					placeholder={t("cyclePlaceholder")}
					maxLength={1000}
					disabled={disabled}
				/>
			</div>
		</div>
	);
}
