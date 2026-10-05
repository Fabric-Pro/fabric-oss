"use client";

import { orpcClient } from "@shared/lib/orpc-client";
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
} from "@ui/components/alert-dialog";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ui/components/card";
import { GitBranchIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const GITLAB_REPOSITORY_LINKS_QUERY_KEY = "gitlab-repository-links";

type RepositoryLink = {
	id: string;
	projectId: string;
	projectName: string;
	repositoryOwner: string;
	repositoryName: string;
	status: string;
	canDisconnect: boolean;
};

/**
 * The organization's GitLab project repository links on the GitLab provider
 * page. A link is a project's own grant, separate from the person's GitLab
 * connection: the copy says so, and each link is disconnected through the
 * project's own repository disconnect (which checks the project permission).
 */
export function GitLabRepositoryLinksCard({
	organizationId,
}: {
	organizationId: string | null | undefined;
}) {
	const queryClient = useQueryClient();
	const [pending, setPending] = useState<RepositoryLink | null>(null);

	const linksQuery = useQuery({
		queryKey: [GITLAB_REPOSITORY_LINKS_QUERY_KEY, organizationId ?? null],
		queryFn: async () =>
			(
				await orpcClient.integrations.gitlab.listRepositoryLinks({
					organizationId: organizationId ?? null,
				})
			).links,
		enabled: Boolean(organizationId),
	});

	const disconnectMutation = useMutation({
		mutationFn: async (link: RepositoryLink) =>
			orpcClient.projects.repositoryIntegrations.disconnect({
				projectId: link.projectId,
				integrationId: link.id,
				organizationId: organizationId ?? null,
			}),
		onSuccess: (_result, link) => {
			toast.success(
				`Disconnected ${link.repositoryOwner}/${link.repositoryName} from ${link.projectName}`,
			);
			setPending(null);
			queryClient.invalidateQueries({
				queryKey: [GITLAB_REPOSITORY_LINKS_QUERY_KEY],
			});
		},
		onError: (error) => {
			toast.error("Failed to disconnect the repository", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	if (!organizationId) {
		return null;
	}

	const links = linksQuery.data ?? [];

	return (
		<Card>
			<CardHeader>
				<CardTitle>Project repository links</CardTitle>
				<CardDescription>
					Repositories connected to individual projects. Each link has
					its own access, separate from your personal GitLab
					connection: disconnecting your own GitLab does not affect
					these links, and disconnecting a link does not disconnect
					you.
				</CardDescription>
			</CardHeader>
			<CardContent>
				{linksQuery.isLoading ? (
					<p className="text-sm text-muted-foreground">
						Loading repository links...
					</p>
				) : linksQuery.isError ? (
					<p className="text-sm text-destructive" role="alert">
						Could not load the project repository links.
					</p>
				) : links.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						No project you can access has a GitLab repository link.
					</p>
				) : (
					<ul
						className="divide-y rounded-lg border"
						aria-label="GitLab project repository links"
					>
						{links.map((link) => {
							const repository = `${link.repositoryOwner}/${link.repositoryName}`;
							return (
								<li
									key={link.id}
									className="flex items-center justify-between gap-4 p-4"
								>
									<div className="flex min-w-0 items-start gap-3">
										<GitBranchIcon
											className="mt-0.5 size-4 shrink-0 text-muted-foreground"
											aria-hidden="true"
										/>
										<div className="min-w-0 space-y-1">
											<p className="truncate text-sm font-medium">
												{repository}
											</p>
											<p className="truncate text-sm text-muted-foreground">
												{link.projectName}
											</p>
										</div>
										{link.status !== "ACTIVE" ? (
											<Badge variant="outline">
												{link.status
													.toLowerCase()
													.replaceAll("_", " ")}
											</Badge>
										) : null}
									</div>
									{link.canDisconnect ? (
										<Button
											variant="outline"
											size="sm"
											onClick={() => setPending(link)}
											aria-label={`Disconnect ${repository} from ${link.projectName}`}
										>
											Disconnect
										</Button>
									) : null}
								</li>
							);
						})}
					</ul>
				)}
			</CardContent>

			<AlertDialog
				open={pending !== null}
				onOpenChange={(open) => {
					if (!open && !disconnectMutation.isPending) {
						setPending(null);
					}
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							Disconnect this repository link?
						</AlertDialogTitle>
						<AlertDialogDescription>
							{pending
								? `${pending.projectName} stops using ${pending.repositoryOwner}/${pending.repositoryName}. Your own GitLab connection is not affected.`
								: null}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel
							disabled={disconnectMutation.isPending}
						>
							Cancel
						</AlertDialogCancel>
						<AlertDialogAction
							disabled={disconnectMutation.isPending}
							onClick={(event) => {
								event.preventDefault();
								if (pending) {
									disconnectMutation.mutate(pending);
								}
							}}
						>
							Disconnect
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</Card>
	);
}
