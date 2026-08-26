"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation } from "@tanstack/react-query";
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
import { Textarea } from "@ui/components/textarea";
import { useEffect, useState } from "react";

/**
 * CreateTopicDialog — manual topic entry. Mirrors the CreateDocumentDialog
 * control shape (Dialog / DialogHeader / DialogFooter). A `title` is required;
 * the pitch is optional. A project-wide duplicate (server CONFLICT) surfaces
 * inline rather than as a toast, so the user can rename without losing input.
 */
export function CreateTopicDialog({
	projectId,
	organizationId,
	open,
	onOpenChange,
	onCreated,
}: {
	projectId: string;
	organizationId: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCreated: () => void;
}) {
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	const createMutation = useMutation(
		orpc.projects.publishingSuite.createTopic.mutationOptions({
			onSuccess: () => {
				onCreated();
				onOpenChange(false);
			},
			onError: (error: unknown) => {
				const code = (error as { code?: string } | null)?.code;
				setErrorMessage(
					code === "CONFLICT"
						? "A topic on this subject already exists."
						: "We couldn't create that topic. Please try again.",
				);
			},
		}),
	);

	// Reset fields + error after the close animation so a reopened dialog is clean.
	useEffect(() => {
		if (!open) {
			const timer = setTimeout(() => {
				setTitle("");
				setDescription("");
				setErrorMessage(null);
			}, 200);
			return () => clearTimeout(timer);
		}
	}, [open]);

	const handleCreate = () => {
		const trimmedTitle = title.trim();
		if (!trimmedTitle) {
			return;
		}
		setErrorMessage(null);
		const trimmedDescription = description.trim();
		createMutation.mutate({
			projectId,
			organizationId,
			title: trimmedTitle,
			description: trimmedDescription ? trimmedDescription : null,
		});
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>Add a topic</DialogTitle>
					<DialogDescription>
						Add your own subject to write about. It joins the
						suggested topics in the list.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="topic-title">Title</Label>
						<Input
							id="topic-title"
							placeholder="What should we write about?"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="topic-description">
							Pitch (optional)
						</Label>
						<Textarea
							id="topic-description"
							placeholder="A sentence or two on the angle."
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							rows={4}
						/>
					</div>
					{errorMessage ? (
						<p role="alert" className="text-sm text-destructive">
							{errorMessage}
						</p>
					) : null}
				</div>
				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={createMutation.isPending}
					>
						Cancel
					</Button>
					<Button
						onClick={handleCreate}
						disabled={createMutation.isPending || !title.trim()}
					>
						{createMutation.isPending ? "Adding…" : "Add topic"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
