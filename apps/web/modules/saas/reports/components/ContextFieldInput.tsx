"use client";

import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { cn } from "@ui/lib";
import type { ReactNode } from "react";

type Props = {
	id: string;
	label: string;
	required: boolean;
	value: string;
	onChange: (value: string) => void;
	helpText: string;
	placeholder?: string;
	/** Show a required field that is still empty in red (report suite). */
	markMissing?: boolean;
	disabled?: boolean;
	inputClassName?: string;
	/** Rendered after the input, e.g. an "auto-detected" check. */
	adornment?: ReactNode;
};

/**
 * One context value the AI uses to find a report's data (a project, a board,
 * an account). The required mark is announced to screen readers, not only
 * drawn as a red asterisk.
 */
export function ContextFieldInput({
	id,
	label,
	required,
	value,
	onChange,
	helpText,
	placeholder,
	markMissing = false,
	disabled,
	inputClassName,
	adornment,
}: Props) {
	const missing = markMissing && required && !value.trim();
	const helpId = `${id}-help`;

	return (
		<div className="space-y-1">
			<Label
				htmlFor={id}
				className={cn("text-sm", missing && "text-destructive")}
			>
				{label}
				{required && (
					<>
						<span
							aria-hidden="true"
							className="ml-1 text-destructive"
						>
							*
						</span>
						<span className="sr-only"> (required)</span>
					</>
				)}
			</Label>
			<div className="flex items-center gap-2">
				<Input
					id={id}
					value={value}
					onChange={(e) => onChange(e.target.value)}
					placeholder={placeholder}
					disabled={disabled}
					aria-required={required || undefined}
					aria-invalid={missing || undefined}
					aria-describedby={helpId}
					className={inputClassName}
				/>
				{adornment}
			</div>
			<p
				id={helpId}
				className={cn(
					"text-[10px]",
					missing ? "text-destructive" : "text-muted-foreground",
				)}
			>
				{missing ? `Required. ${helpText}` : helpText}
			</p>
		</div>
	);
}
