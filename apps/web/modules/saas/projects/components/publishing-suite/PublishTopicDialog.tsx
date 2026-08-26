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
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { useEffect, useState } from "react";

/**
 * PublishTopicDialog — an editorial confirmation for marking a topic Published,
 * collecting an OPTIONAL published URL (FR14/FR15/DV5). Mirrors
 * DeclineTopicDialog: a styled dialog rather than window.prompt, testable
 * without stubbing a browser global. Confirming with an empty field passes
 * `null`. No strict URL validation (DV6).
 *
 * Also reused as the "Edit/Add URL" affordance on an already-PUBLISHED topic
 * (Task 6): `initialUrl` seeds the field on open, and `title`/`confirmLabel`
 * let the caller swap the publish-transition copy for edit-mode copy.
 */
export function PublishTopicDialog({
	topicTitle,
	open,
	onOpenChange,
	onConfirm,
	isPending,
	initialUrl = null,
	title = "Mark as published",
	confirmLabel = "Mark as published",
}: {
	topicTitle: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: (url: string | null) => void;
	isPending?: boolean;
	initialUrl?: string | null;
	title?: string;
	confirmLabel?: string;
}) {
	const [url, setUrl] = useState(initialUrl ?? "");

	// Seed the field from `initialUrl` whenever the dialog opens (so an
	// edit-mode open pre-fills the current URL); clear it after the close
	// animation so a reopened dialog never briefly flashes stale text.
	useEffect(() => {
		if (open) {
			setUrl(initialUrl ?? "");
		} else {
			const timer = setTimeout(() => setUrl(""), 200);
			return () => clearTimeout(timer);
		}
	}, [open, initialUrl]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>
						Optionally add a link to where "{topicTitle}" was
						published.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-2">
					<Label htmlFor="published-url">
						Published URL (optional)
					</Label>
					<Input
						id="published-url"
						type="url"
						placeholder="https://blog.example.com/post"
						value={url}
						onChange={(e) => setUrl(e.target.value)}
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
							onConfirm(url.trim() ? url.trim() : null)
						}
						disabled={isPending}
					>
						{confirmLabel}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
