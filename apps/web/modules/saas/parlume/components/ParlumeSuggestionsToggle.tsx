"use client";

import { Label } from "@ui/components/label";
import { Switch } from "@ui/components/switch";
import { useTranslations } from "next-intl";

/** Whether Parlume may offer unprompted suggestions in the meeting chat. */
export function ParlumeSuggestionsToggle({
	checked,
	onChange,
	disabled,
	idPrefix = "parlume",
}: {
	checked: boolean;
	onChange: (checked: boolean) => void;
	disabled: boolean;
	/** Keeps element ids unique where several toggles share a page. */
	idPrefix?: string;
}) {
	const t = useTranslations("parlume.invite.suggestions");
	const id = `${idPrefix}-suggestions`;
	return (
		<div className="flex items-start gap-3">
			<Switch
				id={id}
				checked={checked}
				onCheckedChange={onChange}
				disabled={disabled}
				aria-describedby={`${id}-description`}
				className="mt-0.5"
			/>
			<div className="space-y-0.5">
				<Label htmlFor={id} className="text-sm font-medium">
					{t("label")}
				</Label>
				<p
					id={`${id}-description`}
					className="text-xs text-muted-foreground"
				>
					{t("description")}
				</p>
			</div>
		</div>
	);
}
