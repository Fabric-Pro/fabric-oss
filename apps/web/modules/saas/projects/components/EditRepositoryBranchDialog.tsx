"use client";

import { orpcClient } from "@shared/lib/orpc-client";
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
import { Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

export interface EditRepositoryBranchDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	integration: {
		id: string;
		repositoryOwner: string;
		repositoryName: string;
		defaultBranch: string;
		provider: string;
	};
	projectId: string;
	organizationId: string | null;
	onSaved: () => void;
}

/** Maps the updateBranch procedure's typed `data.code` to a UI message. */
function messageForCode(
	code: string | undefined,
	branch: string,
): { inline?: string; toast?: string } {
	switch (code) {
		case "BRANCH_NOT_FOUND":
			return { inline: `Branch "${branch}" wasn't found on the remote.` };
		case "REPOSITORY_CREDENTIALS_EXPIRED":
		case "REPOSITORY_DISCONNECTED":
			return {
				inline: "This connection's credentials are no longer valid — use Reconnect, then edit.",
			};
		case "REPOSITORY_UNREACHABLE":
			return {
				toast: "Couldn't reach the repository — try again in a moment.",
			};
		default:
			return {};
	}
}

function errorCode(error: unknown): string | undefined {
	if (error && typeof error === "object" && "data" in error) {
		const data = (error as { data?: { code?: string } }).data;
		return data?.code;
	}
	return undefined;
}

export function EditRepositoryBranchDialog({
	open,
	onOpenChange,
	integration,
	projectId,
	organizationId,
	onSaved,
}: EditRepositoryBranchDialogProps) {
	const [branch, setBranch] = useState(integration.defaultBranch);
	const [inlineError, setInlineError] = useState<string | null>(null);

	// Re-seed the field whenever the target row or open-state changes.
	useEffect(() => {
		if (open) {
			setBranch(integration.defaultBranch);
			setInlineError(null);
		}
	}, [open, integration.id, integration.defaultBranch]);

	const mutation = useMutation({
		mutationFn: (nextBranch: string) =>
			orpcClient.projects.repositoryIntegrations.updateBranch({
				projectId,
				organizationId,
				integrationId: integration.id,
				branch: nextBranch,
			}),
		onSuccess: () => {
			toast.success("Branch updated");
			onSaved();
			onOpenChange(false);
		},
		onError: (error: unknown, nextBranch: string) => {
			const mapped = messageForCode(errorCode(error), nextBranch);
			if (mapped.inline) {
				setInlineError(mapped.inline);
			} else if (mapped.toast) {
				toast.error(mapped.toast);
			} else {
				toast.error(
					error instanceof Error
						? error.message
						: "Failed to update branch",
				);
			}
		},
	});

	const trimmed = branch.trim();
	const saveDisabled =
		trimmed === "" ||
		trimmed === integration.defaultBranch ||
		mutation.isPending ||
		inlineError !== null;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>Edit branch</DialogTitle>
					<DialogDescription>
						{integration.repositoryOwner}/
						{integration.repositoryName}
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-2">
					<Label htmlFor="repo-branch">Monitored branch</Label>
					<Input
						id="repo-branch"
						value={branch}
						onChange={(e) => {
							setBranch(e.target.value);
							if (inlineError) {
								setInlineError(null);
							}
						}}
						aria-invalid={inlineError ? true : undefined}
						aria-describedby={
							inlineError ? "repo-branch-error" : undefined
						}
					/>
					{inlineError && (
						<p
							id="repo-branch-error"
							role="alert"
							className="text-xs text-destructive"
						>
							{inlineError}
						</p>
					)}
				</div>
				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={mutation.isPending}
					>
						Cancel
					</Button>
					<Button
						onClick={() => mutation.mutate(trimmed)}
						disabled={saveDisabled}
					>
						{mutation.isPending && (
							<Loader2Icon className="mr-2 size-4 animate-spin" />
						)}
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
