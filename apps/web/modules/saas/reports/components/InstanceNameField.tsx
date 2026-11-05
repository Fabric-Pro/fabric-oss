"use client";

import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { cn } from "@ui/lib";

/** A report's name. `invalid` is the report suite's red treatment for an empty one. */
export function InstanceNameField({
	value,
	onChange,
	invalid = false,
}: {
	value: string;
	onChange: (value: string) => void;
	invalid?: boolean;
}) {
	return (
		<div className="space-y-2">
			<Label
				htmlFor="instance-name"
				className={cn(invalid && "text-destructive")}
			>
				Instance Name
				<span aria-hidden="true"> *</span>
				<span className="sr-only"> (required)</span>
			</Label>
			<Input
				id="instance-name"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder="e.g., My Weekly Sprint Report"
				aria-required
				aria-invalid={invalid || undefined}
				aria-describedby={
					invalid ? "instance-name-error" : "instance-name-help"
				}
				className={cn(invalid && "border-destructive")}
			/>
			{invalid ? (
				<p
					id="instance-name-error"
					role="alert"
					className="text-xs text-destructive"
				>
					Enter a name for this report.
				</p>
			) : (
				<p
					id="instance-name-help"
					className="text-xs text-muted-foreground"
				>
					Give this instance a name to identify it in your reports
					list
				</p>
			)}
		</div>
	);
}
