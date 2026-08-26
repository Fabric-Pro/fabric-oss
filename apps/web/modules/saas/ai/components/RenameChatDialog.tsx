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
import { useEffect, useState } from "react";

interface RenameChatDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	currentTitle: string;
	onConfirm: (newTitle: string) => void;
}

export function RenameChatDialog({
	open,
	onOpenChange,
	currentTitle,
	onConfirm,
}: RenameChatDialogProps) {
	const [title, setTitle] = useState(currentTitle);

	// Reset title when dialog opens with new currentTitle
	useEffect(() => {
		if (open) {
			setTitle(currentTitle);
		}
	}, [open, currentTitle]);

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (title.trim() && title !== currentTitle) {
			onConfirm(title.trim());
			onOpenChange(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Rename conversation</DialogTitle>
					<DialogDescription>
						Enter a new name for this conversation.
					</DialogDescription>
				</DialogHeader>
				<form onSubmit={handleSubmit}>
					<Input
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						placeholder="Conversation title"
						autoFocus
						className="mb-4"
					/>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={!title.trim() || title === currentTitle}
						>
							Rename
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
