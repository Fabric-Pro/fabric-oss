"use client";

/**
 * Credentials tab under Connections (ADR-026,
 * phase 1): the tokens and keys this organization's members saved once to
 * reuse wherever something connects.
 *
 * Phase 1 lists every credential the viewer may see and lets them add a
 * personal access token, API key or user + token, share their own with the
 * organization, and delete what they manage. OAuth grants and app
 * installations appear here once their connect flows write credentials.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@ui/components/alert-dialog";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { KeyRoundIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import {
	CREDENTIAL_KIND_LABELS,
	CREDENTIAL_PROVIDER_LABELS,
	CREDENTIAL_STATUS_BADGE,
} from "../lib/labels";
import { AddCredentialDialog } from "./AddCredentialDialog";

export function SavedCredentialsView({
	organizationId,
}: {
	organizationId: string;
}) {
	const queryClient = useQueryClient();
	const listOptions = orpc.credentialManager.list.queryOptions({
		input: { organizationId },
	});
	const { data, isLoading, isError } = useQuery(listOptions);
	const invalidate = () =>
		queryClient.invalidateQueries({ queryKey: listOptions.queryKey });

	const share = useMutation({
		mutationFn: (input: { id: string; shareWithOrganization: boolean }) =>
			orpcClient.credentialManager.update({ organizationId, ...input }),
		onSuccess: (_data, input) => {
			toast.success(
				input.shareWithOrganization
					? "Shared with the organization"
					: "No longer shared",
			);
			invalidate();
		},
		onError: (error) =>
			toast.error("Could not change sharing", {
				description: error instanceof Error ? error.message : undefined,
			}),
	});

	const remove = useMutation({
		mutationFn: (id: string) =>
			orpcClient.credentialManager.delete({ organizationId, id }),
		onSuccess: () => {
			toast.success("Credential deleted");
			invalidate();
		},
		onError: (error) =>
			toast.error("Could not delete the credential", {
				description: error instanceof Error ? error.message : undefined,
			}),
	});

	const credentials = data?.credentials ?? [];

	return (
		<section aria-labelledby="credentials-heading" className="space-y-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="max-w-2xl space-y-1">
					<h2
						id="credentials-heading"
						className="font-medium text-base"
					>
						Credentials
					</h2>
					<p className="text-muted-foreground text-sm leading-6">
						Save a token or key once and pick it wherever Fabric
						connects. Your own credentials are private until you
						share them; organization credentials are usable by every
						member.
					</p>
				</div>
				<AddCredentialDialog
					organizationId={organizationId}
					onCreated={invalidate}
				/>
			</div>

			{isLoading ? (
				<p className="text-muted-foreground text-sm">
					Loading credentials…
				</p>
			) : isError ? (
				<p role="alert" className="text-destructive text-sm">
					Credentials could not be loaded.
				</p>
			) : credentials.length === 0 ? (
				<div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-muted-foreground text-sm">
					No credentials yet. Add a personal access token or API key
					to reuse it across connections.
				</div>
			) : (
				<ul className="divide-y divide-border rounded-lg border border-border">
					{credentials.map((credential) => {
						const status =
							CREDENTIAL_STATUS_BADGE[credential.status];
						return (
							<li
								key={credential.id}
								className="flex flex-wrap items-center gap-3 px-4 py-3"
							>
								<KeyRoundIcon
									className="size-4 shrink-0 text-muted-foreground"
									aria-hidden="true"
								/>
								<div className="min-w-0 flex-1 space-y-0.5">
									<p className="truncate font-medium text-sm">
										{credential.label}
										{credential.externalAccountLogin ? (
											<span className="font-normal text-muted-foreground">
												{` · ${credential.externalAccountLogin}`}
											</span>
										) : null}
									</p>
									<p className="truncate text-muted-foreground text-xs">
										{
											CREDENTIAL_PROVIDER_LABELS[
												credential.provider
											]
										}{" "}
										·{" "}
										{
											CREDENTIAL_KIND_LABELS[
												credential.kind
											]
										}{" "}
										·{" "}
										{credential.origin.replace(
											/^https:\/\//,
											"",
										)}
										{credential.scopes.length > 0
											? ` · ${credential.scopes.join(", ")}`
											: ""}
									</p>
								</div>
								<Badge variant="outline">
									{credential.owner === "organization"
										? "Organization"
										: credential.ownedByMe
											? credential.sharing ===
												"ORGANIZATION"
												? "Mine, shared"
												: "Mine"
											: "Shared by a member"}
								</Badge>
								<Badge variant={status.variant}>
									{status.label}
								</Badge>
								{credential.canManage &&
								credential.owner === "member" ? (
									<Button
										type="button"
										variant="outline"
										size="sm"
										disabled={share.isPending}
										onClick={() =>
											share.mutate({
												id: credential.id,
												shareWithOrganization:
													credential.sharing !==
													"ORGANIZATION",
											})
										}
									>
										{credential.sharing === "ORGANIZATION"
											? "Stop sharing"
											: "Share"}
									</Button>
								) : null}
								{credential.canManage ? (
									<AlertDialog>
										<AlertDialogTrigger asChild>
											<Button
												type="button"
												variant="ghost"
												size="icon-sm"
												aria-label={`Delete ${credential.label}`}
											>
												<Trash2Icon
													className="size-4"
													aria-hidden="true"
												/>
											</Button>
										</AlertDialogTrigger>
										<AlertDialogContent>
											<AlertDialogHeader>
												<AlertDialogTitle>
													Delete “{credential.label}”?
												</AlertDialogTitle>
												<AlertDialogDescription>
													Fabric forgets this
													credential. The token itself
													stays valid at the provider;
													revoke it there too if you
													no longer need it.
												</AlertDialogDescription>
											</AlertDialogHeader>
											<AlertDialogFooter>
												<AlertDialogCancel>
													Cancel
												</AlertDialogCancel>
												<AlertDialogAction
													onClick={() =>
														remove.mutate(
															credential.id,
														)
													}
												>
													Delete
												</AlertDialogAction>
											</AlertDialogFooter>
										</AlertDialogContent>
									</AlertDialog>
								) : null}
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}
