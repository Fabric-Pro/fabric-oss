"use client";

import { Label } from "@ui/components/label";
import { Switch } from "@ui/components/switch";
import { useTranslations } from "next-intl";

/** Whether Parlume may offer unprompted suggestions in the meeting chat. */
export function ParlumeSuggestionsToggle({
	checked,
	onChange,
	disabled,
}: {
	checked: boolean;
	onChange: (checked: boolean) => void;
	disabled: boolean;
}) {
	const t = useTranslations("parlume.invite.suggestions");
	return (
		<div className="flex items-start gap-3">
			<Switch
				id="parlume-suggestions"
				checked={checked}
				onCheckedChange={onChange}
				disabled={disabled}
				aria-describedby="parlume-suggestions-description"
				className="mt-0.5"
			/>
			<div className="space-y-0.5">
				<Label
					htmlFor="parlume-suggestions"
					className="text-sm font-medium"
				>
					{t("label")}
				</Label>
				<p
					id="parlume-suggestions-description"
					className="text-xs text-muted-foreground"
				>
					{t("description")}
				</p>
			</div>
		</div>
	);
}
