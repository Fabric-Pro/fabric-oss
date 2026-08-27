"use client";

import { PUBLISHING_SNOOZE_PRESETS } from "@repo/database/src/publishing-snooze";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Label } from "@ui/components/label";
import { RadioGroup, RadioGroupItem } from "@ui/components/radio-group";
import { Textarea } from "@ui/components/textarea";
import { useEffect, useState } from "react";

export type SnoozePreset = (typeof PUBLISHING_SNOOZE_PRESETS)[number];

/**
 * The three durations FR6 allows, labelled for display.
 *
 * Derived from the server's own list rather than hand-written, so a UI option
 * that the server would reject cannot exist: the array below is index-aligned
 * to PUBLISHING_SNOOZE_PRESETS and a mismatch is a type error, not a 400 the
 * user discovers.
 */
const PRESET_LABELS: Record<SnoozePreset, string> = {
	ONE_WEEK: "1 week",
	ONE_MONTH: "1 month",
	THREE_MONTHS: "3 months",
};

/**
 * SnoozeTopicDialog — pick one of three durations, optionally say why.
 *
 * Mirrors DeclineTopicDialog: a styled dialog, an OPTIONAL rationale, and a
 * confirm that leaves closing to the caller so a failed mutation keeps the
 * typed text instead of discarding it.
 *
 * The duration picker uses Radix's RadioGroup (see ShareFrameSheet.tsx for
 * the established usage in this codebase) rather than a hand-rolled group of
 * role="radio" buttons. Radix implements the full WAI-ARIA radio pattern —
 * roving tabindex (only the checked option sits in the Tab sequence) and
 * arrow-key navigation between options — which a plain button group with
 * role="radio" + aria-checked does NOT get for free; Tab would visit every
 * option and the arrow keys would do nothing.
 *
 * The label text sits INSIDE each RadioGroupItem (as children, rendered
 * alongside the check indicator — see the `children` support added to
 * `@ui/components/radio-group`) rather than in a sibling <Label htmlFor>.
 * That keeps the pill self-labelling (the visible text IS the accessible
 * name, via `aria-label`, satisfying WCAG "Label in Name") and keeps the
 * rendered duration text inside the radio element itself, not a sibling node.
 */
export function SnoozeTopicDialog({
	topicTitle,
	open,
	onOpenChange,
	onConfirm,
	isPending,
}: {
	topicTitle: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: (preset: SnoozePreset, reason: string | null) => void;
	isPending?: boolean;
}) {
	const [preset, setPreset] = useState<SnoozePreset>("ONE_WEEK");
	const [reason, setReason] = useState("");

	// Reset after the close animation so a reopened dialog starts fresh —
	// mirrors DeclineTopicDialog's 200ms.
	useEffect(() => {
		if (!open) {
			const timer = setTimeout(() => {
				setReason("");
				setPreset("ONE_WEEK");
			}, 200);
			return () => clearTimeout(timer);
		}
	}, [open]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>Snooze topic</DialogTitle>
					<DialogDescription>
						Hide "{topicTitle}" from the Inbox until later. It comes
						back on its own — nothing is lost.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-2">
					<span
						className="app-editorial-label"
						id="snooze-duration-label"
					>
						Snooze duration
					</span>
					<RadioGroup
						aria-labelledby="snooze-duration-label"
						value={preset}
						onValueChange={(value) =>
							setPreset(value as SnoozePreset)
						}
						disabled={isPending}
						className="flex flex-wrap gap-2"
					>
						{PUBLISHING_SNOOZE_PRESETS.map((value) => (
							<RadioGroupItem
								key={value}
								value={value}
								id={`snooze-preset-${value}`}
								aria-label={PRESET_LABELS[value]}
								className="aspect-auto h-auto w-auto inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground data-[state=checked]:border-primary data-[state=checked]:bg-primary/10 data-[state=checked]:text-primary"
							>
								{PRESET_LABELS[value]}
							</RadioGroupItem>
						))}
					</RadioGroup>
				</div>
				<div className="space-y-2">
					<Label htmlFor="snooze-reason">Reason (optional)</Label>
					<Textarea
						id="snooze-reason"
						placeholder="e.g. Waiting on the release to land"
						value={reason}
						onChange={(e) => setReason(e.target.value)}
						rows={3}
					/>
				</div>
				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={isPending}
					>
						Cancel
					</Button>
					<Button
						onClick={() =>
							onConfirm(
								preset,
								reason.trim() ? reason.trim() : null,
							)
						}
						disabled={isPending}
					>
						Snooze topic
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
