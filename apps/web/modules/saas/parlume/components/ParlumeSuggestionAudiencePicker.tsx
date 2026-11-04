"use client";

import type { ParlumeSuggestionAudience } from "@repo/api/modules/projects/lib/parlume-suggestion-audience";
import { Label } from "@ui/components/label";
import { RadioGroup, RadioGroupItem } from "@ui/components/radio-group";

const AUDIENCES = [
	{
		value: "MEETING",
		title: "Everyone in the meeting (chat)",
		description:
			"Suggestions and the recap are posted in the meeting chat. Every participant sees them, external guests included.",
	},
	{
		value: "TEAM",
		title: "Only your team (Parlume page)",
		description:
			"Nothing is posted in the chat. Suggestions and the recap appear on this project's Parlume page, for people who can read the project.",
	},
] as const satisfies ReadonlyArray<{
	value: ParlumeSuggestionAudience;
	title: string;
	description: string;
}>;

function isAudience(value: string): value is ParlumeSuggestionAudience {
	return AUDIENCES.some((audience) => audience.value === value);
}

/** Who sees Parlume's suggestions and recap: the whole meeting, or the project's team. */
export function ParlumeSuggestionAudiencePicker({
	audience,
	onChange,
	disabled,
	idPrefix = "parlume",
}: {
	audience: ParlumeSuggestionAudience;
	onChange: (audience: ParlumeSuggestionAudience) => void;
	disabled: boolean;
	/** Keeps element ids unique where several pickers share a page. */
	idPrefix?: string;
}) {
	const labelId = `${idPrefix}-audience-label`;
	return (
		<div className="min-w-0 space-y-2">
			<span
				id={labelId}
				className="block text-sm font-medium leading-none"
			>
				Who sees suggestions
			</span>
			<RadioGroup
				aria-labelledby={labelId}
				value={audience}
				onValueChange={(value) => {
					if (isAudience(value)) {
						onChange(value);
					}
				}}
				disabled={disabled}
				className="grid-cols-[repeat(auto-fit,minmax(13rem,1fr))]"
			>
				{AUDIENCES.map((option) => {
					const id = `${idPrefix}-audience-${option.value.toLowerCase()}`;
					return (
						<Label
							key={option.value}
							htmlFor={id}
							className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-3 font-normal leading-normal has-[[data-state=checked]]:border-foreground"
						>
							<RadioGroupItem
								id={id}
								value={option.value}
								className="mt-0.5"
								aria-labelledby={`${id}-title`}
								aria-describedby={`${id}-description`}
							/>
							<span className="flex flex-col gap-0.5">
								<span
									id={`${id}-title`}
									className="text-sm font-medium"
								>
									{option.title}
								</span>
								<span
									id={`${id}-description`}
									className="text-xs text-muted-foreground"
								>
									{option.description}
								</span>
							</span>
						</Label>
					);
				})}
			</RadioGroup>
		</div>
	);
}
