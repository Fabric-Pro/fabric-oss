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

export interface AttachRepositoryPatDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	integration: {
		id: string;
		repositoryOwner: string;
		repositoryName: string;
		provider: string;
		status: string;
	};
	projectId: string;
	onSaved: () => void;
}

/**
 * AC5 (Fizzy #2252): attach a personal access token to an existing repository
 * integration WITHOUT disconnecting — the remedy for a No-access row, where
 * the credential works but cannot read this repository and reconnecting
 * cannot help. The procedure validates the token against the repository
 * before storing anything; failures surface verbatim.
 */
export function AttachRepositoryPatDialog({
	open,
	onOpenChange,
	integration,
	projectId,
	onSaved,
}: AttachRepositoryPatDialogProps) {
	const [pat, setPat] = useState("");
	const [azureOrganization, setAzureOrganization] = useState("");
	const [inlineError, setInlineError] = useState<string | null>(null);

	useEffect(() => {
		if (open) {
			setPat("");
			setAzureOrganization("");
			setInlineError(null);
		}
	}, [open, integration.id]);

	const mutation = useMutation({
		mutationFn: () =>
			orpcClient.projects.repositoryIntegrations.attachPat({
				projectId,
				integrationId: integration.id,
				patToken: pat.trim(),
				...(integration.provider === "AZURE_DEVOPS" &&
				azureOrganization.trim()
					? { azureOrganization: azureOrganization.trim() }
					: {}),
			}),
		onSuccess: () => {
			toast.success(
				"Token attached — the repository is verified and active.",
			);
			onSaved();
			onOpenChange(false);
		},
		onError: (error: unknown) => {
			setInlineError(
				error instanceof Error
					? error.message
					: "Failed to attach token",
			);
		},
	});

	const saveDisabled = pat.trim() === "" || mutation.isPending;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>Connect with a token (PAT)</DialogTitle>
					<DialogDescription>
						Replaces the stored credential for{" "}
						{integration.repositoryOwner}/
						{integration.repositoryName}
						{integration.status === "REPO_UNAVAILABLE"
							? " — the current credentials can't read this repository. A personal access token with read access restores it without disconnecting."
							: "."}
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-2">
					<Label htmlFor="repo-pat">Personal access token</Label>
					<Input
						id="repo-pat"
						type="password"
						autoComplete="off"
						value={pat}
						onChange={(e) => {
							setPat(e.target.value);
							if (inlineError) {
								setInlineError(null);
							}
						}}
						aria-invalid={inlineError ? true : undefined}
						aria-describedby={
							inlineError ? "repo-pat-error" : undefined
						}
					/>
					{integration.provider === "AZURE_DEVOPS" && (
						<>
							<Label htmlFor="repo-pat-org">
								Azure organization
							</Label>
							<Input
								id="repo-pat-org"
								value={azureOrganization}
								onChange={(e) =>
									setAzureOrganization(e.target.value)
								}
							/>
						</>
					)}
					{inlineError && (
						<p
							id="repo-pat-error"
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
						onClick={() => mutation.mutate()}
						disabled={pat.trim() === "" || mutation.isPending}
					>
						{mutation.isPending && (
							<Loader2Icon className="mr-2 size-4 animate-spin" />
						)}
						Attach token
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
