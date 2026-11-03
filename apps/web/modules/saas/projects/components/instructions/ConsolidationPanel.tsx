"use client";

/**
 * "Move AI files out of the code repository" (specs/2026-10-21-ai-artifacts-hub
 * §5.2, P4). Fabric scans a connected code repository for AI tool files,
 * creates a separate instructions repository, copies the files there in the
 * canonical layout, reads Coding Instructions from it, and opens a pull
 * request removing the files from the code repository.
 *
 * The panel shows the newest run (polled while it runs) and opens the dialog:
 * pick the code repository, review the scanned files, name the new
 * repository, and optionally paste a GitHub token that may create it.
 */

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { Checkbox } from "@ui/components/checkbox";
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
import { ExternalLinkIcon, Loader2Icon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import type { RepositorySyncIntegration } from "../../lib/instructions-repository-sync";
import { RepositoryChoice } from "./RepositoryChoice";

const STEP_LABELS: Record<string, string> = {
	CREATED: "Starting",
	COPYING: "Copying the files into the instructions repository",
	CONFIGURING: "Reading Coding Instructions from the instructions repository",
	CLEANUP: "Opening the cleanup pull request in the code repository",
	DONE: "Done",
};

const TARGET_LABELS: Record<string, string> = {
	INSTRUCTIONS: "Always-on instructions",
	RULE: "Rules",
	SKILL: "Skills",
	AGENT: "Agents",
	COMMAND: "Commands",
	KNOWLEDGE: "Knowledge",
	TOOL: "Tool settings and hooks (kept, not delivered)",
};

function errorMessage(error: unknown): string {
	return error instanceof Error && error.message
		? error.message
		: "Something went wrong. Try again.";
}

export function ConsolidationPanel({
	projectId,
	canEdit,
}: {
	projectId: string;
	canEdit?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const queryClient = useQueryClient();
	const searchParams = useSearchParams();
	// A project just imported from its repository opens here with
	// `?consolidate=1`: offer the move once, when there is something to move.
	const [offered, setOffered] = useState(false);
	const consolidation = useQuery({
		...orpc.projects.instructions.repositorySync.getConsolidation.queryOptions(
			{ input: { projectId } },
		),
		refetchInterval: (query) =>
			query.state.data?.run?.status === "RUNNING" ? 3000 : false,
	});
	const retry = useMutation(
		orpc.projects.instructions.repositorySync.retryConsolidation.mutationOptions(),
	);
	const sync = useQuery(
		orpc.projects.instructions.repositorySync.get.queryOptions({
			input: { projectId },
		}),
	);
	// The repository Coding Instructions already read from is not a code
	// repository to move files out of (after a move it is the new one).
	const syncedId = sync.data?.configured?.repositoryIntegrationId ?? null;
	const integrations: RepositorySyncIntegration[] = (
		sync.data?.availableIntegrations ?? []
	).filter((i) => i.id !== syncedId);
	const run = consolidation.data?.run ?? null;
	useEffect(() => {
		if (
			!offered &&
			canEdit &&
			searchParams?.get("consolidate") === "1" &&
			consolidation.isSuccess &&
			run === null &&
			integrations.length > 0
		) {
			setOffered(true);
			setOpen(true);
		}
	}, [
		offered,
		canEdit,
		searchParams,
		consolidation.isSuccess,
		run,
		integrations.length,
	]);

	if (!canEdit && !run) {
		return null;
	}
	return (
		<Card className="flex flex-col gap-2 p-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex flex-col gap-0.5">
					<p className="font-medium text-sm">
						Keep AI files out of the code repository
					</p>
					<p className="text-muted-foreground text-xs">
						Fabric moves the code repository's AI tool files into a
						separate instructions repository and delivers them to
						coding tools through its plugin and MCP server.
					</p>
				</div>
				{canEdit && run?.status !== "RUNNING" ? (
					<Button
						size="sm"
						variant={
							run?.status === "COMPLETED" ? "outline" : "primary"
						}
						disabled={integrations.length === 0}
						onClick={() => setOpen(true)}
					>
						Move AI files out
					</Button>
				) : null}
			</div>
			{integrations.length === 0 && canEdit && !run ? (
				<p className="text-muted-foreground text-xs">
					Connect the code repository to the project first.
				</p>
			) : null}
			{run ? <RunStatus run={run} /> : null}
			{canEdit && run?.status === "FAILED" && run.targetRepositoryUrl ? (
				<Button
					size="sm"
					variant="outline"
					className="self-start"
					disabled={retry.isPending}
					onClick={() =>
						retry.mutate(
							{ projectId },
							{
								onSuccess: () =>
									void queryClient.invalidateQueries({
										queryKey:
											orpc.projects.instructions.repositorySync.key(),
									}),
								onError: (error) =>
									toast.error(
										error instanceof Error
											? error.message
											: "The retry could not start.",
									),
							},
						)
					}
				>
					Retry with the same repository
				</Button>
			) : null}
			{open ? (
				<ConsolidationDialog
					projectId={projectId}
					integrations={integrations}
					onOpenChange={setOpen}
					onStarted={() => {
						void queryClient.invalidateQueries({
							queryKey:
								orpc.projects.instructions.repositorySync.key(),
						});
						void queryClient.invalidateQueries({
							queryKey: orpc.projects.instructions.key(),
						});
					}}
				/>
			) : null}
		</Card>
	);
}

type RunView = {
	status: "RUNNING" | "COMPLETED" | "FAILED";
	step: string;
	fileCount: number;
	targetRepositoryUrl: string | null;
	cleanupPullRequestUrl: string | null;
	error: string | null;
};

function RunStatus({ run }: { run: RunView }) {
	return (
		<div className="flex flex-col gap-1 text-sm" aria-live="polite">
			<div className="flex flex-wrap items-center gap-2">
				{run.status === "RUNNING" ? (
					<Badge status="info">
						<Loader2Icon
							className="mr-1 size-3 motion-safe:animate-spin"
							aria-hidden="true"
						/>
						{STEP_LABELS[run.step] ?? run.step}
					</Badge>
				) : run.status === "COMPLETED" ? (
					<Badge status="success">Moved {run.fileCount} files</Badge>
				) : (
					<Badge status="error">Move failed</Badge>
				)}
				{run.targetRepositoryUrl ? (
					<a
						href={run.targetRepositoryUrl}
						target="_blank"
						rel="noreferrer"
						className="inline-flex items-center gap-1 text-xs underline"
					>
						Instructions repository
						<ExternalLinkIcon
							className="size-3"
							aria-hidden="true"
						/>
					</a>
				) : null}
				{run.cleanupPullRequestUrl ? (
					<a
						href={run.cleanupPullRequestUrl}
						target="_blank"
						rel="noreferrer"
						className="inline-flex items-center gap-1 text-xs underline"
					>
						Cleanup pull request
						<ExternalLinkIcon
							className="size-3"
							aria-hidden="true"
						/>
					</a>
				) : null}
			</div>
			{run.status === "FAILED" && run.error ? (
				<p role="alert" className="text-destructive text-xs">
					{run.error}
				</p>
			) : null}
			{run.status === "COMPLETED" ? (
				<p className="text-muted-foreground text-xs">
					Merge the cleanup pull request, then connect your coding
					tool to Fabric (the Coding Instructions plugin) to keep
					working with the instructions.
				</p>
			) : null}
		</div>
	);
}

type PlanItem = {
	from: string;
	to: string | null;
	target: string;
	tool: string;
	defaultIncluded: boolean;
	duplicateOf?: string;
};

function ConsolidationDialog({
	projectId,
	integrations,
	onOpenChange,
	onStarted,
}: {
	projectId: string;
	integrations: RepositorySyncIntegration[];
	onOpenChange: (open: boolean) => void;
	onStarted: () => void;
}) {
	const id = useId();
	const [integrationId, setIntegrationId] = useState(
		integrations[0]?.id ?? "",
	);
	const preview = useMutation(
		orpc.projects.instructions.repositorySync.previewConsolidation.mutationOptions(),
	);
	const start = useMutation(
		orpc.projects.instructions.repositorySync.startConsolidation.mutationOptions(),
	);
	const [selected, setSelected] = useState<Set<string> | null>(null);
	const [owner, setOwner] = useState("");
	const [name, setName] = useState("");
	const [isPrivate, setIsPrivate] = useState(true);
	const [token, setToken] = useState("");
	const [problem, setProblem] = useState<string | null>(null);
	const plan = preview.data;
	const items = (plan?.items ?? []) as PlanItem[];
	const pending = preview.isPending || start.isPending;

	const groups = useMemo(() => {
		const byTarget = new Map<string, PlanItem[]>();
		for (const item of items) {
			const list = byTarget.get(item.target) ?? [];
			list.push(item);
			byTarget.set(item.target, list);
		}
		return [...byTarget.entries()];
	}, [items]);

	async function scan() {
		setProblem(null);
		try {
			const result = await preview.mutateAsync({
				projectId,
				repositoryIntegrationId: integrationId,
			});
			setSelected(
				new Set(
					(result.items as PlanItem[])
						.filter((i) => i.defaultIncluded)
						.map((i) => i.from),
				),
			);
			setOwner(result.suggested.owner);
			setName(result.suggested.name);
		} catch (error) {
			setProblem(errorMessage(error));
		}
	}

	async function submit() {
		if (!selected) {
			return;
		}
		setProblem(null);
		try {
			await start.mutateAsync({
				projectId,
				repositoryIntegrationId: integrationId,
				repository: {
					owner: owner.trim() === "" ? null : owner.trim(),
					name: name.trim(),
					private: isPrivate,
				},
				...(token.trim() === "" ? {} : { token: token.trim() }),
				include: [...selected],
			});
		} catch (error) {
			setProblem(errorMessage(error));
			return;
		}
		toast.success("Moving the AI files. This takes a minute.");
		onStarted();
		onOpenChange(false);
	}

	// Opening the dialog scans the first repository straight away.
	// biome-ignore lint/correctness/useExhaustiveDependencies: once, on open
	useEffect(() => {
		if (integrationId !== "") {
			void scan();
		}
	}, []);

	function toggle(from: string, on: boolean) {
		setSelected((current) => {
			const next = new Set(current ?? []);
			if (on) {
				next.add(from);
			} else {
				next.delete(from);
			}
			return next;
		});
	}

	const chosen = selected?.size ?? 0;
	const tokenRequired = plan ? !plan.storedTokenAvailable : false;
	const blocked =
		!plan ||
		chosen === 0 ||
		name.trim() === "" ||
		(tokenRequired && token.trim() === "");

	return (
		<Dialog
			open
			onOpenChange={(next) => {
				if (pending && !next) {
					return;
				}
				onOpenChange(next);
			}}
		>
			<DialogContent className="max-h-[90vh] max-w-2xl grid-cols-[minmax(0,1fr)] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>
						Move AI files out of the code repository
					</DialogTitle>
					<DialogDescription>
						Fabric creates a separate GitHub repository for the AI
						instructions, copies the selected files there, reads
						Coding Instructions from it, and opens a pull request
						that removes them from the code repository. Nothing is
						removed until you merge that pull request.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-4">
					<div className="flex flex-wrap items-end gap-2">
						<div className="min-w-0 flex-1">
							<RepositoryChoice
								integrations={integrations}
								integrationId={integrationId}
								onChoose={(next) => {
									setIntegrationId(next.id);
									setSelected(null);
									preview.reset();
								}}
							/>
						</div>
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={pending || integrationId === ""}
							onClick={() => void scan()}
						>
							{preview.isPending ? (
								<Loader2Icon
									className="size-4 motion-safe:animate-spin"
									aria-hidden="true"
								/>
							) : null}
							{plan ? "Scan again" : "Scan for AI files"}
						</Button>
					</div>

					{plan && items.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							No AI tool files were found on{" "}
							{`${plan.repository.owner}/${plan.repository.name}@${plan.repository.defaultBranch}`}
							.
						</p>
					) : null}

					{plan && items.length > 0 ? (
						<fieldset className="flex flex-col gap-3">
							<legend className="mb-1 font-medium text-sm">
								{chosen} of {items.length} files selected
							</legend>
							{groups.map(([target, list]) => (
								<div
									key={target}
									className="flex flex-col gap-1"
								>
									<p className="text-muted-foreground text-xs">
										{TARGET_LABELS[target] ?? target}
									</p>
									<ul className="flex flex-col gap-1">
										{list.map((item) => {
											const checkboxId = `${id}-${item.from}`;
											return (
												<li
													key={item.from}
													className="flex items-start gap-2 text-xs"
												>
													<Checkbox
														id={checkboxId}
														checked={
															selected?.has(
																item.from,
															) ?? false
														}
														disabled={pending}
														onCheckedChange={(
															value,
														) =>
															toggle(
																item.from,
																value === true,
															)
														}
													/>
													<label
														htmlFor={checkboxId}
														className="min-w-0 break-all"
													>
														<code>{item.from}</code>
														{item.to ? (
															<span className="text-muted-foreground">
																{" → "}
																<code>
																	{item.to}
																</code>
															</span>
														) : (
															<span className="text-muted-foreground">
																{" "}
																(same as{" "}
																{
																	item.duplicateOf
																}
																; removed only)
															</span>
														)}
														{item.defaultIncluded ? null : (
															<span className="text-muted-foreground">
																{" "}
																· a root folder
																that may be
																application code
															</span>
														)}
													</label>
												</li>
											);
										})}
									</ul>
								</div>
							))}
							{plan.skipped.length > 0 ? (
								<p className="text-muted-foreground text-xs">
									Left in place:{" "}
									{plan.skipped.map((s) => s.path).join(", ")}
								</p>
							) : null}
						</fieldset>
					) : null}

					{plan && items.length > 0 ? (
						<div className="grid gap-3 sm:grid-cols-2">
							<div className="flex flex-col gap-1.5">
								<Label htmlFor={`${id}-owner`}>Owner</Label>
								<Input
									id={`${id}-owner`}
									value={owner}
									disabled={pending}
									onChange={(e) => setOwner(e.target.value)}
								/>
							</div>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor={`${id}-name`}>
									New repository name
								</Label>
								<Input
									id={`${id}-name`}
									value={name}
									disabled={pending}
									onChange={(e) => setName(e.target.value)}
								/>
							</div>
							<div className="flex items-center gap-2 sm:col-span-2">
								<Checkbox
									id={`${id}-private`}
									checked={isPrivate}
									disabled={pending}
									onCheckedChange={(value) =>
										setIsPrivate(value === true)
									}
								/>
								<Label htmlFor={`${id}-private`}>
									Private repository
								</Label>
							</div>
							<div className="flex flex-col gap-1.5 sm:col-span-2">
								<Label htmlFor={`${id}-token`}>
									GitHub token
									{tokenRequired ? "" : " (optional)"}
								</Label>
								<Input
									id={`${id}-token`}
									type="password"
									autoComplete="off"
									value={token}
									disabled={pending}
									onChange={(e) => setToken(e.target.value)}
									aria-describedby={`${id}-token-hint`}
								/>
								<p
									id={`${id}-token-hint`}
									className="text-muted-foreground text-xs"
								>
									{tokenRequired
										? "A personal access token that may create repositories under the owner (classic: repo; fine-grained: Administration and Contents, read and write). Fabric stores it encrypted on the new repository's connection."
										: "Leave empty to use your GitHub sign-in or saved token; paste one only if GitHub refuses to create the repository."}
								</p>
							</div>
						</div>
					) : null}

					{problem ? (
						<p role="alert" className="text-destructive text-xs">
							{problem}
						</p>
					) : null}
				</div>
				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						disabled={pending}
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button
						type="button"
						disabled={pending || blocked}
						onClick={() => void submit()}
					>
						{start.isPending ? (
							<Loader2Icon
								className="size-4 motion-safe:animate-spin"
								aria-hidden="true"
							/>
						) : null}
						Create repository and move {chosen} files
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
