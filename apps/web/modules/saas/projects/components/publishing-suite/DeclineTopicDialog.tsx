"use client";

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
import { Textarea } from "@ui/components/textarea";
import { useEffect, useState } from "react";

/**
 * DeclineTopicDialog — a small, editorial confirmation for declining a topic.
 *
 * Controller decision: declining goes through this STYLED dialog rather than a
 * native `window.prompt`, so it matches the design system and stays testable
 * without stubbing a browser global. The reason is OPTIONAL — confirming with
 * an empty field passes `null`.
 */
export function DeclineTopicDialog({
	topicTitle,
	open,
	onOpenChange,
	onConfirm,
	isPending,
}: {
	topicTitle: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: (reason: string | null) => void;
	isPending?: boolean;
}) {
	const [reason, setReason] = useState("");

	// Clear the field after the close animation so a reopened dialog starts blank.
	useEffect(() => {
		if (!open) {
			const timer = setTimeout(() => setReason(""), 200);
			return () => clearTimeout(timer);
		}
	}, [open]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>Decline topic</DialogTitle>
					<DialogDescription>
						Optionally note why "{topicTitle}" isn't a fit. Kept for
						context — it isn't shared publicly.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-2">
					<Label htmlFor="decline-reason">Reason (optional)</Label>
					<Textarea
						id="decline-reason"
						placeholder="e.g. Off-topic for our audience"
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
						variant="destructive"
						onClick={() =>
							onConfirm(reason.trim() ? reason.trim() : null)
						}
						disabled={isPending}
					>
						Decline topic
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
