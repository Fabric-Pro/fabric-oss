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
 *
 * The review has two groups: development instructions (checked, moved) and
 * files shipped with the product (unchecked, they stay): the skills and
 * settings the repository's own coding-tool plugin publishes, generated
 * copies, and files kept on an earlier move. Each shipped file says why.
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
			{run?.status === "COMPLETED" && run.cleanupPullRequestUrl ? (
				<CleanupPullRequest
					projectId={projectId}
					fallbackUrl={run.cleanupPullRequestUrl}
				/>
			) : null}
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
			{run.status === "COMPLETED" && !run.cleanupPullRequestUrl ? (
				<p className="text-muted-foreground text-xs">{NEXT_STEP}</p>
			) : null}
		</div>
	);
}

const NEXT_STEP =
	"Connect your coding tool to Fabric (the Coding Instructions plugin) to keep working with the instructions.";

/**
 * The cleanup pull request, read live from the code repository: merge it
 * here after a confirmation, or open it to merge it yourself. A merge found
 * on open or on a refetch shows the next step.
 */
function CleanupPullRequest({
	projectId,
	fallbackUrl,
}: {
	projectId: string;
	fallbackUrl: string;
}) {
	const queryClient = useQueryClient();
	const [confirming, setConfirming] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const status = useQuery(
		orpc.projects.instructions.repositorySync.getConsolidationCleanupPullRequest.queryOptions(
			{ input: { projectId } },
		),
	);
	const merge = useMutation(
		orpc.projects.instructions.repositorySync.mergeConsolidationCleanupPullRequest.mutationOptions(),
	);
	const pr = status.data?.pullRequest ?? null;
	const url = pr?.url || fallbackUrl;

	async function confirmMerge() {
		if (!pr?.number) {
			return;
		}
		setProblem(null);
		try {
			await merge.mutateAsync({
				projectId,
				pullRequestNumber: pr.number,
			});
			toast.success("Cleanup merged.");
			setConfirming(false);
		} catch (error) {
			setProblem(errorMessage(error));
		}
		void queryClient.invalidateQueries({
			queryKey:
				orpc.projects.instructions.repositorySync.getConsolidationCleanupPullRequest.key(),
		});
	}

	if (status.isPending) {
		return (
			<p className="text-muted-foreground text-xs">
				Checking the cleanup pull request…
			</p>
		);
	}
	if (pr?.state === "MERGED") {
		return (
			<div className="flex flex-col gap-1" aria-live="polite">
				<Badge status="success" className="self-start">
					Cleanup merged
				</Badge>
				<p className="text-muted-foreground text-xs">
					Next: {NEXT_STEP.charAt(0).toLowerCase()}
					{NEXT_STEP.slice(1)}
				</p>
			</div>
		);
	}
	if (pr?.state === "CLOSED") {
		return (
			<output className="block text-xs">
				Pull request #{pr.number} was closed without merging, so the AI
				files are still in the code repository. Reopen it in{" "}
				{providerName(pr.provider)}, or move the AI files out again.
			</output>
		);
	}
	const open = pr?.state === "OPEN";
	return (
		<div className="flex flex-col gap-2">
			<p className="text-muted-foreground text-xs">
				{open
					? `Merge the cleanup pull request to remove the AI files from ${pr.repository}, then connect your coding tool.`
					: "Merge the cleanup pull request, then connect your coding tool to Fabric (the Coding Instructions plugin)."}
			</p>
			<div className="flex flex-wrap items-center gap-3">
				{open && pr.canMerge ? (
					<Button
						size="sm"
						className="self-start"
						onClick={() => {
							setProblem(null);
							setConfirming(true);
						}}
					>
						Merge cleanup PR
					</Button>
				) : null}
				<a
					href={url}
					target="_blank"
					rel="noreferrer"
					className="inline-flex items-center gap-1 text-xs underline"
				>
					{open && pr.canMerge
						? "I'll merge it myself"
						: "Open the cleanup pull request"}
					<ExternalLinkIcon className="size-3" aria-hidden="true" />
					<span className="sr-only">(opens in a new tab)</span>
				</a>
			</div>
			{problem && !confirming ? (
				<p role="alert" className="text-destructive text-xs">
					{problem}
				</p>
			) : null}
			{confirming && pr ? (
				<Dialog
					open
					onOpenChange={(next) => {
						if (!next && !merge.isPending) {
							setConfirming(false);
						}
					}}
				>
					<DialogContent className="max-w-md">
						<DialogHeader>
							<DialogTitle>
								Merge the cleanup pull request
							</DialogTitle>
							<DialogDescription>
								Merge pull request #{pr.number} into{" "}
								<code>{pr.defaultBranch}</code>? It deletes{" "}
								{pr.fileCount} AI tool files from{" "}
								{pr.repository}.
							</DialogDescription>
						</DialogHeader>
						{problem ? (
							<p
								role="alert"
								className="text-destructive text-xs"
							>
								{problem}
							</p>
						) : null}
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								disabled={merge.isPending}
								onClick={() => setConfirming(false)}
							>
								Cancel
							</Button>
							<Button
								type="button"
								disabled={merge.isPending}
								onClick={() => void confirmMerge()}
							>
								{merge.isPending ? (
									<Loader2Icon
										className="size-4 motion-safe:animate-spin"
										aria-hidden="true"
									/>
								) : null}
								Merge
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			) : null}
		</div>
	);
}

function providerName(provider: string): string {
	return provider === "GITLAB"
		? "GitLab"
		: provider === "AZURE_DEVOPS"
			? "Azure DevOps"
			: "GitHub";
}

type PlanItem = {
	path: string;
	to: string | null;
	target: string;
	tool: string;
	defaultIncluded: boolean;
	duplicateOf?: string;
	group: "development" | "product";
	reason?: string;
	selected: boolean;
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
	const items = (plan?.files ?? []) as PlanItem[];
	const pending = preview.isPending || start.isPending;

	const { development, product } = useMemo(() => {
		const byTarget = new Map<string, PlanItem[]>();
		const shipped: PlanItem[] = [];
		for (const item of items) {
			if (item.group === "product") {
				shipped.push(item);
				continue;
			}
			const list = byTarget.get(item.target) ?? [];
			list.push(item);
			byTarget.set(item.target, list);
		}
		return { development: [...byTarget.entries()], product: shipped };
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
					(result.files as PlanItem[])
						.filter((i) => i.selected)
						.map((i) => i.path),
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
	const countSelected = (list: PlanItem[]) =>
		list.filter((item) => selected?.has(item.path)).length;
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
						<div className="flex flex-col gap-4">
							<p
								className="font-medium text-sm"
								aria-live="polite"
							>
								{chosen} of {items.length} files selected
							</p>
							{development.length > 0 ? (
								<fieldset
									className="flex flex-col gap-3"
									aria-describedby={`${id}-development-hint`}
								>
									<legend className="mb-1 font-medium text-sm">
										Development instructions (move) ·{" "}
										{countSelected(
											development.flatMap(
												([, list]) => list,
											),
										)}{" "}
										selected
									</legend>
									<p
										id={`${id}-development-hint`}
										className="text-muted-foreground text-xs"
									>
										Instructions for working on this
										repository. They move to the
										instructions repository.
									</p>
									{development.map(([target, list]) => (
										<div
											key={target}
											className="flex flex-col gap-1"
										>
											<p className="text-muted-foreground text-xs">
												{TARGET_LABELS[target] ??
													target}
											</p>
											<FileList
												id={id}
												items={list}
												selected={selected}
												pending={pending}
												onToggle={toggle}
											/>
										</div>
									))}
								</fieldset>
							) : null}
							{product.length > 0 ? (
								<fieldset
									className="flex flex-col gap-1"
									aria-describedby={`${id}-product-hint`}
								>
									<legend className="mb-1 font-medium text-sm">
										Shipped with your product (stay) ·{" "}
										{countSelected(product)} selected
									</legend>
									<p
										id={`${id}-product-hint`}
										className="text-muted-foreground text-xs"
									>
										Your product publishes or generates
										these files, for example its own
										coding-tool plugin. Moving them out
										would break it, so they stay in the code
										repository unless you check them.
									</p>
									<FileList
										id={id}
										items={product}
										selected={selected}
										pending={pending}
										onToggle={toggle}
									/>
								</fieldset>
							) : null}
							{plan.skipped.length > 0 ? (
								<p className="text-muted-foreground text-xs">
									Left in place:{" "}
									{plan.skipped.map((s) => s.path).join(", ")}
								</p>
							) : null}
						</div>
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
						Move {chosen} {chosen === 1 ? "file" : "files"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function FileList({
	id,
	items,
	selected,
	pending,
	onToggle,
}: {
	id: string;
	items: PlanItem[];
	selected: Set<string> | null;
	pending: boolean;
	onToggle: (path: string, on: boolean) => void;
}) {
	return (
		<ul className="flex flex-col gap-1">
			{items.map((item) => {
				const checkboxId = `${id}-${item.path}`;
				const reasonId = `${checkboxId}-reason`;
				return (
					<li
						key={item.path}
						className="flex items-start gap-2 text-xs"
					>
						<Checkbox
							id={checkboxId}
							checked={selected?.has(item.path) ?? false}
							disabled={pending}
							aria-describedby={
								item.reason ? reasonId : undefined
							}
							onCheckedChange={(value) =>
								onToggle(item.path, value === true)
							}
						/>
						<div className="flex min-w-0 flex-col gap-0.5">
							<label
								htmlFor={checkboxId}
								className="min-w-0 break-all"
							>
								<code>{item.path}</code>
								{item.to ? (
									<span className="text-muted-foreground">
										{" → "}
										<code>{item.to}</code>
									</span>
								) : (
									<span className="text-muted-foreground">
										{" "}
										(same as {item.duplicateOf}; removed
										only)
									</span>
								)}
								{item.group === "development" &&
								!item.defaultIncluded ? (
									<span className="text-muted-foreground">
										{" "}
										· a root folder that may be application
										code
									</span>
								) : null}
							</label>
							{item.reason ? (
								<p
									id={reasonId}
									className="break-words text-muted-foreground"
								>
									{item.reason}
								</p>
							) : null}
						</div>
					</li>
				);
			})}
		</ul>
	);
}
