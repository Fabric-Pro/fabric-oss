"use client";

import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Label } from "@ui/components/label";
import { cn } from "@ui/lib";
import { useEffect, useState } from "react";

const POST_TYPE_OPTIONS = [
	{ value: "TWEET", label: "Tweet" },
	{ value: "BLOG_POST", label: "Blog Post" },
	{ value: "CASE_STUDY", label: "Case Study" },
	{ value: "STAKEHOLDER_EMAIL", label: "Stakeholder Email" },
] as const;

type PostTypeValue = (typeof POST_TYPE_OPTIONS)[number]["value"];

/**
 * PostTypesDialog — override-only editor for a topic's suggested post types.
 * Save submits the checked set (possibly empty); Reset submits `null` (revert
 * to the AI suggestion). The chip row on the card stays display-only.
 *
 * A topic can carry SEVERAL post types at once, and this dialog has always
 * allowed that — the toggle keeps a `Set` and Save submits every checked
 * value. What it did not do was *look* like it: four bare 16px checkboxes
 * stacked in a column, one of them ticked, is the canonical shape of a radio
 * group, so review read it as single-select. Hence the grouping, the "select
 * all that apply" cue and the live count below — each one a signal a radio
 * group could not produce. The control itself stays a `Checkbox`, which is
 * what assistive tech was already announcing correctly.
 */
export function PostTypesDialog({
	topicTitle,
	open,
	onOpenChange,
	initialSelected,
	hasOverride,
	hasAiSuggestion,
	onSubmit,
	isPending,
}: {
	topicTitle: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	initialSelected: readonly PostTypeValue[];
	hasOverride: boolean;
	hasAiSuggestion: boolean;
	onSubmit: (postTypes: PostTypeValue[] | null) => void;
	isPending?: boolean;
}) {
	const [selected, setSelected] = useState<Set<PostTypeValue>>(
		() => new Set(initialSelected),
	);

	// Re-seed to the topic's CURRENT effective set each time the dialog opens,
	// so a prior cancel can't leak stale checks into a reopen.
	useEffect(() => {
		if (open) {
			setSelected(new Set(initialSelected));
		}
	}, [open, initialSelected]);

	const toggle = (value: PostTypeValue, checked: boolean) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (checked) {
				next.add(value);
			} else {
				next.delete(value);
			}
			return next;
		});
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>Edit post types</DialogTitle>
					<DialogDescription>
						Choose which post types fit "{topicTitle}" — select all
						that apply.
						{hasAiSuggestion
							? " This overrides the AI suggestion."
							: null}
					</DialogDescription>
				</DialogHeader>
				<fieldset className="space-y-2">
					<legend className="sr-only">
						Post types — select all that apply
					</legend>
					{POST_TYPE_OPTIONS.map((o) => {
						const isChecked = selected.has(o.value);
						return (
							<Label
								key={o.value}
								htmlFor={`post-type-${o.value}`}
								className={cn(
									"flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors",
									isChecked
										? "border-primary/60 bg-primary/10"
										: "border-border bg-card",
									isPending
										? "cursor-not-allowed opacity-50"
										: "cursor-pointer hover:bg-accent",
								)}
							>
								<Checkbox
									id={`post-type-${o.value}`}
									checked={isChecked}
									onCheckedChange={(c) =>
										toggle(o.value, c === true)
									}
									disabled={isPending}
								/>
								<span>{o.label}</span>
							</Label>
						);
					})}
					{/* A radio group cannot report a count — saying one out loud
					    is the plainest statement that more than one is allowed,
					    and `aria-live` carries it to screen readers too. */}
					<p
						aria-live="polite"
						className="pt-1 text-muted-foreground text-xs"
						data-testid="post-types-selected-count"
					>
						{selected.size === 0
							? "None selected"
							: `${selected.size} of ${POST_TYPE_OPTIONS.length} selected`}
					</p>
				</fieldset>
				<DialogFooter>
					<Button
						variant="ghost"
						onClick={() => onOpenChange(false)}
						disabled={isPending}
					>
						Cancel
					</Button>
					{hasOverride ? (
						<Button
							variant="outline"
							onClick={() => onSubmit(null)}
							disabled={isPending}
						>
							{hasAiSuggestion
								? "Reset to AI suggestion"
								: "Clear types"}
						</Button>
					) : null}
					<Button
						onClick={() =>
							onSubmit(
								POST_TYPE_OPTIONS.map((o) => o.value).filter(
									(v) => selected.has(v),
								),
							)
						}
						disabled={isPending}
					>
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
