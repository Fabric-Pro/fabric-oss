"use client";

import { CredentialPicker } from "@saas/credential-manager/components/CredentialPicker";
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
import { Loader2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

/** Kinds a repository can run with; matches the server's requirement. */
const REPOSITORY_CREDENTIAL_KINDS = ["PAT", "OAUTH", "GITHUB_APP_USER"];

export interface ChooseRepositoryCredentialDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	integration: {
		id: string;
		repositoryOwner: string;
		repositoryName: string;
		provider: "GITHUB" | "GITLAB";
		credentialId: string | null;
	};
	projectId: string;
	organizationId: string;
	onSaved: () => void;
}

/**
 * Chooses the credential-manager credential a repository runs with
 * (ADR-026), or returns it to its stored connection. The server checks the
 * caller may use the credential and that it can read the repository before
 * anything is saved; its refusal is shown as is.
 */
export function ChooseRepositoryCredentialDialog({
	open,
	onOpenChange,
	integration,
	projectId,
	organizationId,
	onSaved,
}: ChooseRepositoryCredentialDialogProps) {
	const [credentialId, setCredentialId] = useState(integration.credentialId);
	const [inlineError, setInlineError] = useState<string | null>(null);

	const mutation = useMutation({
		mutationFn: () =>
			orpcClient.projects.repositoryIntegrations.setCredential({
				projectId,
				integrationId: integration.id,
				credentialId,
			}),
		onSuccess: () => {
			toast.success(
				credentialId
					? "Credential chosen — the repository is verified and active."
					: "The repository uses its stored connection again.",
			);
			onSaved();
			onOpenChange(false);
		},
		onError: (error: unknown) => {
			setInlineError(
				error instanceof Error
					? error.message
					: "Failed to choose the credential",
			);
		},
	});

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>Choose credential</DialogTitle>
					<DialogDescription>
						The credential Fabric reads and writes{" "}
						{integration.repositoryOwner}/
						{integration.repositoryName} with. It needs read access
						to the repository, and write access to push branches and
						open pull requests.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-2">
					<CredentialPicker
						organizationId={organizationId}
						provider={integration.provider}
						kinds={REPOSITORY_CREDENTIAL_KINDS}
						connectionLabel="Stored connection"
						value={credentialId}
						onChange={(next) => {
							setCredentialId(next);
							setInlineError(null);
						}}
						disabled={mutation.isPending}
					/>
					{inlineError && (
						<p role="alert" className="text-xs text-destructive">
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
						disabled={
							credentialId === integration.credentialId ||
							mutation.isPending
						}
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
