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
		title: "Actions",
		description:
			"Makes the changes attendees ask for, with your permissions, as soon as they ask.",
	},
] as const;

/** Whether attendees can only ask, or can also ask for changes. */
export function ParlumeModePicker({
	toolsReadOnly,
	onChange,
	disabled,
	idPrefix = "parlume",
}: {
	toolsReadOnly: boolean;
	onChange: (toolsReadOnly: boolean) => void;
	disabled: boolean;
	/** Keeps element ids unique where several pickers share a page. */
	idPrefix?: string;
}) {
	const labelId = `${idPrefix}-mode-label`;
	return (
		<div className="min-w-0 flex-[2_1_22rem] space-y-2">
			<span
				id={labelId}
				className="block text-sm font-medium leading-none"
			>
				What Parlume can do
			</span>
			<RadioGroup
				aria-labelledby={labelId}
				value={toolsReadOnly ? "read" : "act"}
				onValueChange={(value) => onChange(value === "read")}
				disabled={disabled}
				className="grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]"
			>
				{MODES.map((mode) => {
					const id = `${idPrefix}-mode-${mode.value}`;
					return (
						<Label
							key={mode.value}
							htmlFor={id}
							className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-3 font-normal leading-normal has-[[data-state=checked]]:border-foreground"
						>
							<RadioGroupItem
								id={id}
								value={mode.value}
								className="mt-0.5"
								aria-labelledby={`${id}-title`}
								aria-describedby={`${id}-description`}
							/>
							<span className="flex flex-col gap-0.5">
								<span
									id={`${id}-title`}
									className="text-sm font-medium"
								>
									{mode.title}
								</span>
								<span
									id={`${id}-description`}
									className="text-xs text-muted-foreground"
								>
									{mode.description}
								</span>
							</span>
						</Label>
					);
				})}
			</RadioGroup>
		</div>
	);
}
