"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { InfoIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PipelineProviderIcon } from "../test-cases/pipeline/PipelineProviderIcon";

/** Maps the repo-integration provider enum onto the pipeline provider tag. */
const PROVIDER_TAG: Record<string, string> = {
	GITHUB: "github-actions",
	GITLAB: "gitlab-ci",
	AZURE_DEVOPS: "azure-devops",
};

type Source = {
	integrationId: string;
	provider: string;
	owner: string;
	repo: string;
	defaultBranch: string;
	qaBranch: string | null;
	effectiveBranch: string;
};

/**
 * Settings ▸ Testing — which branch QA pulls CI results from, per connected repo.
 *
 * The sync follows the repository's default branch unless a branch is set here.
 * That override exists because `defaultBranch` also drives code indexing: a team
 * whose CI publishes test reports on `develop` must be able to point QA there
 * without moving what Atlas indexes. Blank restores the default, so there is no
 * separate "reset" action to get wrong.
 */
export function QaPipelineSourcesSettings({
	projectId,
	canEdit,
}: {
	projectId: string;
	canEdit: boolean;
}) {
	const queryClient = useQueryClient();
	// Only the row being edited holds a draft — an unsaved edit on one repo must
	// not follow the user to another row, and a refetch must not clobber typing.
	const [draft, setDraft] = useState<{ id: string; value: string } | null>(
		null,
	);

	const query = useQuery(
		orpc.projects.pipelineResults.sources.queryOptions({
			input: { projectId },
		}),
	);

	const setBranch = useMutation(
		orpc.projects.pipelineResults.setBranch.mutationOptions({
			onSuccess: () => {
				toast.success("Branch updated. The next sync uses it.");
				setDraft(null);
				for (const key of [
					orpc.projects.pipelineResults.sources.key(),
					orpc.projects.pipelineResults.syncStates.key(),
				]) {
					queryClient.invalidateQueries({ queryKey: key });
				}
			},
			onError: (error) => toast.error(error.message),
		}),
	);

	const sources = (query.data?.sources ?? []) as Source[];
	/**
	 * What to say when nothing is connected. Composed server-side, because the
	 * distinction it draws ("nothing connected" vs "your PM tool cannot do this")
	 * depends on configuration the browser does not have.
	 */
	const noSourcesReason = query.data?.noSourcesReason ?? null;

	if (query.isLoading) {
		return (
			<div className="flex items-center gap-2 py-3 text-muted-foreground text-sm">
				<Loader2Icon
					className="size-4 motion-safe:animate-spin"
					aria-hidden="true"
				/>
				Loading connected repositories…
			</div>
		);
	}

	// A failed load must not fall through to the empty state below: "no
	// repositories are connected" is a claim about the project, and saying it
	// when we simply could not read would send someone to reconnect a repo that
	// is already there.
	if (query.isError) {
		return (
			<p className="flex items-center gap-1.5 py-3 text-destructive text-sm">
				<TriangleAlertIcon className="size-3.5" aria-hidden="true" />
				Couldn't load the connected repositories.
			</p>
		);
	}

	return (
		<section
			className="space-y-3"
			data-onboarding-target="qa-pipeline-sources"
		>
			<div className="flex items-center gap-1.5">
				<Label className="font-medium text-sm">Pipeline sources</Label>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							aria-label="About pipeline source branches"
							className="rounded text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
						>
							<InfoIcon className="size-3.5" aria-hidden="true" />
						</button>
					</TooltipTrigger>
					<TooltipContent className="max-w-xs">
						QA pulls finished CI runs from each connected
						repository. It follows the repository's default branch
						unless you set a branch here — useful when your test
						reports are published from a branch other than the one
						you develop on. This does not change which branch Atlas
						indexes.
					</TooltipContent>
				</Tooltip>
			</div>

			{sources.length === 0 ? (
				<p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-5 text-center text-muted-foreground text-sm">
					{/*
					 * "Nothing is connected" and "the thing you
					 * connected cannot do this" need different sentences: a
					 * customer who connected Azure DevOps as their PM tool has
					 * already done what they believe was asked, and an
					 * undifferentiated empty state sends them to check a
					 * connection that is working perfectly well at its own job.
					 */}
					{noSourcesReason ??
						"No repositories are connected to this project yet. Connect one under Settings ▸ Development to pull CI test results."}
				</p>
			) : (
				<ul className="divide-y divide-border rounded-md border border-border">
					{sources.map((source) => {
						const isEditing = draft?.id === source.integrationId;
						const value = isEditing
							? draft.value
							: (source.qaBranch ?? "");
						const pending =
							setBranch.isPending &&
							draft?.id === source.integrationId;
						return (
							<li
								key={source.integrationId}
								className="flex flex-wrap items-center gap-3 px-3 py-3"
							>
								<PipelineProviderIcon
									provider={
										PROVIDER_TAG[source.provider] ??
										source.provider
									}
									className="size-4 shrink-0"
								/>
								<div className="min-w-0 flex-1">
									<p className="truncate font-medium text-sm">
										{source.owner}/{source.repo}
									</p>
									<p className="truncate text-muted-foreground text-xs">
										Syncing{" "}
										<span className="font-mono">
											{source.effectiveBranch}
										</span>
										{source.qaBranch
											? " (override)"
											: " (repository default)"}
									</p>
								</div>
								<div className="flex items-center gap-2">
									<Input
										value={value}
										disabled={!canEdit || pending}
										onChange={(e) =>
											setDraft({
												id: source.integrationId,
												value: e.target.value,
											})
										}
										placeholder={source.defaultBranch}
										aria-label={`QA branch for ${source.owner}/${source.repo}`}
										className="h-8 w-44 font-mono text-sm"
									/>
									<Button
										type="button"
										size="sm"
										variant="outline"
										disabled={
											!canEdit || !isEditing || pending
										}
										onClick={() =>
											setBranch.mutate({
												projectId,
												integrationId:
													source.integrationId,
												qaBranch: value.trim(),
											})
										}
									>
										{pending ? (
											<Loader2Icon
												className="size-3.5 motion-safe:animate-spin"
												aria-hidden="true"
											/>
										) : (
											"Save"
										)}
									</Button>
								</div>
							</li>
						);
					})}
				</ul>
			)}
			<p className="text-muted-foreground text-xs">
				Leave blank to follow the repository's default branch.
			</p>
		</section>
	);
}
