"use client";

import { Label } from "@ui/components/label";
import { Textarea } from "@ui/components/textarea";
import { useTranslations } from "next-intl";
import { PROPOSAL_STYLE_DIRECTION_MAX_CHARS } from "./proposal-style-model";

/**
 * The Style tab's free-text direction for the visuals, with its count and,
 * after a save the server refused for its length, the reason beside it.
 */
export function StyleDirectionField({
	idPrefix,
	value,
	tooLong,
	disabled,
	onChange,
}: {
	idPrefix: string;
	value: string;
	/** The last save was refused because the direction is too long. */
	tooLong: boolean;
	disabled: boolean;
	onChange: (value: string) => void;
}) {
	const t = useTranslations("projects.proposalArtifact.style");
	const ids = {
		direction: `${idPrefix}-direction`,
		help: `${idPrefix}-direction-help`,
		count: `${idPrefix}-direction-count`,
		error: `${idPrefix}-direction-error`,
	};

	return (
		<div className="space-y-2">
			<Label htmlFor={ids.direction}>{t("styleDirection")}</Label>
			<Textarea
				id={ids.direction}
				value={value}
				maxLength={PROPOSAL_STYLE_DIRECTION_MAX_CHARS}
				placeholder={t("styleDirectionPlaceholder")}
				aria-describedby={[
					ids.help,
					ids.count,
					tooLong ? ids.error : null,
				]
					.filter(Boolean)
					.join(" ")}
				aria-invalid={tooLong || undefined}
				disabled={disabled}
				onChange={(e) => onChange(e.target.value)}
			/>
			<div className="flex flex-wrap justify-between gap-2">
				<p id={ids.help} className="text-muted-foreground text-xs">
					{t("styleDirectionHelp")}
				</p>
				<p
					id={ids.count}
					className="text-muted-foreground text-xs tabular-nums"
				>
					{t("characterCount", {
						count: value.length,
						max: PROPOSAL_STYLE_DIRECTION_MAX_CHARS,
					})}
				</p>
			</div>
			{tooLong && (
				<p id={ids.error} className="text-destructive text-xs">
					{t("directionTooLong", {
						max: PROPOSAL_STYLE_DIRECTION_MAX_CHARS,
					})}
				</p>
			)}
		</div>
	);
}
