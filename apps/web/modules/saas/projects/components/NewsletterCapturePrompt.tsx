"use client";

import { NEWSLETTER_CAPTURE_BRIEF_MAX } from "@repo/database/src/newsletter-schema";
import { Button } from "@ui/components/button";
import { Label } from "@ui/components/label";
import { Textarea } from "@ui/components/textarea";
import { useId, useState } from "react";

/**
 * Describe the screen a screenshot should show, then capture it. Used to
 * capture a new screenshot for a highlight and to capture an image again.
 */
export function NewsletterCapturePrompt({
	label,
	submitLabel,
	initial,
	required,
	disabled,
	onSubmit,
	onCancel,
}: {
	label: string;
	submitLabel: string;
	initial: string;
	/** A new capture needs a description; capturing again may keep the old one. */
	required: boolean;
	disabled: boolean;
	onSubmit: (prompt: string) => void;
	onCancel?: () => void;
}) {
	const id = useId();
	const helpId = useId();
	const [value, setValue] = useState(initial);
	const trimmed = value.trim();

	return (
		<form
			className="w-full space-y-1.5"
			onSubmit={(event) => {
				event.preventDefault();
				if (!required || trimmed) {
					onSubmit(trimmed);
				}
			}}
		>
			<Label htmlFor={id}>{label}</Label>
			<Textarea
				id={id}
				value={value}
				rows={2}
				maxLength={NEWSLETTER_CAPTURE_BRIEF_MAX}
				disabled={disabled}
				aria-describedby={helpId}
				onChange={(event) => setValue(event.target.value)}
			/>
			<p id={helpId} className="text-muted-foreground text-xs">
				Name the screen and what should be on it, for example "the
				project overview with the new filters panel open".
			</p>
			<div className="flex flex-wrap gap-2">
				<Button
					type="submit"
					size="sm"
					variant="outline"
					disabled={disabled || (required && !trimmed)}
				>
					{submitLabel}
				</Button>
				{onCancel ? (
					<Button
						type="button"
						size="sm"
						variant="ghost"
						onClick={onCancel}
					>
						Cancel
					</Button>
				) : null}
			</div>
		</form>
	);
}
