"use client";

import { Label } from "@ui/components/label";
import { RadioGroup, RadioGroupItem } from "@ui/components/radio-group";

const MODES = [
	{
		value: "read",
		title: "Read-only",
		description:
			"Answers questions and looks up information. It cannot make changes.",
	},
	{
		value: "act",
		title: "Actions with confirmation",
		description:
			"Makes changes with your permissions after the requester confirms. Blocked if the speaker can't be identified.",
	},
] as const;

/** Whether attendees can only ask, or can also ask for changes. */
export function ParlumeModePicker({
	toolsReadOnly,
	onChange,
	disabled,
}: {
	toolsReadOnly: boolean;
	onChange: (toolsReadOnly: boolean) => void;
	disabled: boolean;
}) {
	return (
		<div className="min-w-0 flex-[2_1_22rem] space-y-2">
			<span
				id="parlume-mode-label"
				className="block text-sm font-medium leading-none"
			>
				What Parlume can do
			</span>
			<RadioGroup
				aria-labelledby="parlume-mode-label"
				value={toolsReadOnly ? "read" : "act"}
				onValueChange={(value) => onChange(value === "read")}
				disabled={disabled}
				className="grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]"
			>
				{MODES.map((mode) => (
					<Label
						key={mode.value}
						htmlFor={`parlume-mode-${mode.value}`}
						className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-3 font-normal leading-normal has-[[data-state=checked]]:border-foreground"
					>
						<RadioGroupItem
							id={`parlume-mode-${mode.value}`}
							value={mode.value}
							className="mt-0.5"
							aria-labelledby={`parlume-mode-${mode.value}-title`}
							aria-describedby={`parlume-mode-${mode.value}-description`}
						/>
						<span className="flex flex-col gap-0.5">
							<span
								id={`parlume-mode-${mode.value}-title`}
								className="text-sm font-medium"
							>
								{mode.title}
							</span>
							<span
								id={`parlume-mode-${mode.value}-description`}
								className="text-xs text-muted-foreground"
							>
								{mode.description}
							</span>
						</span>
					</Label>
				))}
			</RadioGroup>
		</div>
	);
}
