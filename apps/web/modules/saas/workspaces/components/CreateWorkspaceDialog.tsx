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
import { useState } from "react";
import { toast } from "sonner";

interface CreateWorkspaceDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	organizationId?: string | null;
	onSuccess?: () => void;
}

export function CreateWorkspaceDialog({
	open,
	onOpenChange,
	organizationId,
	onSuccess,
}: CreateWorkspaceDialogProps) {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");

	const createMutation = useMutation({
		mutationFn: async () => {
			return orpc.documentWorkspaces.create.call({
				name,
				description: description || undefined,
				organizationId: organizationId ?? null,
			});
		},
		onSuccess: () => {
			toast.success("Workspace created successfully");
			setName("");
			setDescription("");
			onSuccess?.();
		},
		onError: (error) => {
			toast.error(error.message || "Failed to create workspace");
		},
	});

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!name.trim()) {
			toast.error("Please enter a workspace name");
			return;
		}
		createMutation.mutate();
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Create New Workspace</DialogTitle>
					<DialogDescription>
						Create a workspace to organize your documents. Documents
						uploaded to workspaces can be used by AI agents for
						intelligent retrieval.
					</DialogDescription>
				</DialogHeader>
				<form onSubmit={handleSubmit}>
					<div className="space-y-4 py-4">
						<div className="space-y-2">
							<Label htmlFor="name">Name</Label>
							<Input
								id="name"
								placeholder="My Workspace"
								value={name}
								onChange={(e) => setName(e.target.value)}
								maxLength={100}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="description">
								Description (optional)
							</Label>
							<Textarea
								id="description"
								placeholder="Describe the purpose of this workspace..."
								value={description}
								onChange={(e) => setDescription(e.target.value)}
								rows={3}
								maxLength={500}
							/>
						</div>
					</div>
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
							disabled={createMutation.isPending}
						>
							{createMutation.isPending
								? "Creating..."
								: "Create Workspace"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
