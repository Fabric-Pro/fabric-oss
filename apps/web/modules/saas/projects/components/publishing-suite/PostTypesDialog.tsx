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
						Choose which post types fit "{topicTitle}".
						{hasAiSuggestion
							? " This overrides the AI suggestion."
							: null}
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-3">
					{POST_TYPE_OPTIONS.map((o) => (
						<div key={o.value} className="flex items-center gap-2">
							<Checkbox
								id={`post-type-${o.value}`}
								checked={selected.has(o.value)}
								onCheckedChange={(c) =>
									toggle(o.value, c === true)
								}
								disabled={isPending}
							/>
							<Label htmlFor={`post-type-${o.value}`}>
								{o.label}
							</Label>
						</div>
					))}
				</div>
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
