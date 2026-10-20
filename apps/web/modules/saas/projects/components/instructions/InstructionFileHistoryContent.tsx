"use client";

import { useInstructionActionError } from "@saas/projects/hooks/use-instruction-action-error";
import { safeHttpsUrl } from "@saas/projects/lib/instructions-direct-commit";
import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Skeleton } from "@ui/components/skeleton";
import { useFormatter, useTranslations } from "next-intl";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { InstructionDiffBody } from "./InstructionDiffBody";

export type FileRestoreRequest = Parameters<
	typeof orpcClient.projects.instructions.repository.restoreFile
>[0];
type RepositoryState = Awaited<
	ReturnType<typeof orpcClient.projects.instructions.repository.getState>
>;
type ReadyState = Extract<RepositoryState, { availability: "READY" }>;

export function InstructionFileHistoryContent({
	projectId,
	path,
	...props
}: {
	projectId: string;
	path: string;
	canRestore: boolean;
	blockedReason: string | null;
	stale: boolean;
	submissionError: string | null;
	onRefresh: () => void;
	onRestore: (request: FileRestoreRequest & { branch: string }) => void;
}) {
	const t = useTranslations("projects.codingInstructions.fileHistory");
	const errorText = useInstructionActionError();
	const state = useQuery({
		queryKey: ["instruction-file-history-state", projectId, path],
		queryFn: () =>
			orpcClient.projects.instructions.repository.getState({ projectId }),
		staleTime: 0,
		gcTime: 0,
		refetchOnMount: "always",
		refetchOnWindowFocus: false,
		retry: false,
	});
	let content: ReactNode;
	if (state.isError) {
		content = (
			<p role="alert">
				{t("loadError")} {errorText(state.error)}
			</p>
		);
	} else if (!state.isFetchedAfterMount || state.isFetching || !state.data) {
		content = <Skeleton className="h-24 w-full" />;
	} else if (state.data.availability !== "READY") {
		content = (
			<p role="alert">{t(`availability.${state.data.availability}`)}</p>
		);
	} else {
		content = (
			<ReadyHistory
				key={`${state.data.generation}:${state.data.currentCommitSha}`}
				projectId={projectId}
				path={path}
				state={state.data}
				{...props}
			/>
		);
	}
	return (
		<div className="space-y-4">
			<Button size="sm" variant="outline" onClick={props.onRefresh}>
				{t("refresh")}
			</Button>
			{content}
		</div>
	);
}

function ReadyHistory({
	projectId,
	path,
	state,
	canRestore,
	blockedReason,
	stale,
	submissionError,
	onRefresh,
	onRestore,
}: {
	projectId: string;
	path: string;
	state: ReadyState;
	canRestore: boolean;
	blockedReason: string | null;
	stale: boolean;
	submissionError: string | null;
	onRefresh: () => void;
	onRestore: (request: FileRestoreRequest & { branch: string }) => void;
}) {
	const t = useTranslations("projects.codingInstructions.fileHistory");
	const format = useFormatter();
	const errorText = useInstructionActionError();
	const { confirm } = useConfirmationAlert();
	const [selected, setSelected] = useState<string | null>(null);
	const currentSelection = useRef({
		selected,
		blockedReason,
		canRestore,
		stale,
	});
	currentSelection.current = { selected, blockedReason, canRestore, stale };
	const mounted = useRef(true);
	// Closing or changing the file must invalidate a still-open deletion confirmation.
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const history = useInfiniteQuery({
		queryKey: [
			"instruction-file-git-history",
			projectId,
			path,
			state.generation,
			state.currentCommitSha,
		],
		queryFn: ({ pageParam }) =>
			orpcClient.projects.instructions.repository.listCommits({
				projectId,
				path,
				generation: state.generation,
				commitSha: state.currentCommitSha,
				cursor: pageParam,
			}),
		initialPageParam: 1,
		getNextPageParam: (last) => last.nextCursor,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: 0,
		retry: false,
		refetchOnWindowFocus: false,
	});
	const preview = useQuery({
		...orpc.projects.instructions.repository.previewFileRestore.queryOptions(
			{
				input: {
					projectId,
					path,
					generation: state.generation,
					currentCommitSha: state.currentCommitSha,
					targetCommitSha: selected ?? state.currentCommitSha,
				},
			},
		),
		enabled: selected !== null,
		staleTime: 0,
		gcTime: 0,
		retry: false,
		refetchOnWindowFocus: false,
	});
	const comparison =
		selected !== null && !preview.isFetching && !preview.isError
			? preview.data
			: undefined;
	const refusal =
		blockedReason ??
		(!canRestore ? t("permission") : stale ? t("stale") : null);
	const requestRestore = () => {
		if (!comparison || !comparison.restore.available || refusal) {
			return;
		}
		const request = {
			projectId,
			path,
			generation: comparison.nativeBase.generation,
			currentCommitSha: comparison.nativeBase.commitSha,
			targetCommitSha: comparison.targetCommitSha,
			branch: state.ref,
		};
		const submit = () => {
			const latest = currentSelection.current;
			if (
				mounted.current &&
				latest.selected === request.targetCommitSha &&
				latest.canRestore &&
				!latest.blockedReason &&
				!latest.stale
			) {
				onRestore(request);
			}
		};
		if (comparison.restore.operation === "delete") {
			confirm({
				title: t("deleteTitle", { path }),
				message: t("deleteMessage"),
				confirmLabel: t("deleteAction"),
				destructive: true,
				onConfirm: submit,
			});
		} else {
			submit();
		}
	};
	const commits = history.data?.pages.flatMap((page) => page.commits) ?? [];
	const lastPage = history.data?.pages.at(-1);
	const repositoryUrl = safeHttpsUrl(state.repositoryUrl);
	return (
		<div className="space-y-4">
			<p className="break-all text-muted-foreground text-sm">
				{repositoryUrl ? (
					<a
						className="underline"
						href={repositoryUrl}
						target="_blank"
						rel="noopener noreferrer"
					>
						{state.repositoryUrl}
					</a>
				) : (
					state.repositoryUrl
				)}{" "}
				· {state.ref} · {state.rootPath || "/"}
			</p>
			<p className="break-all text-sm">
				{t("currentRevision", { sha: state.currentCommitSha })}
			</p>
			<div className="grid min-w-0 gap-4 md:grid-cols-3">
				<div className="min-w-0 space-y-3">
					{history.isPending ? (
						<Skeleton className="h-24 w-full" />
					) : null}
					{history.isError ? (
						<p role="alert">
							{t("loadError")} {errorText(history.error)}
						</p>
					) : null}
					{history.isSuccess &&
					commits.length === 0 &&
					!lastPage?.hasMore ? (
						<p>{t("empty")}</p>
					) : null}
					<ul
						className="max-h-96 space-y-2 overflow-auto"
						aria-label={t("versions")}
					>
						{commits.map((commit) => {
							const url = safeHttpsUrl(commit.url);
							return (
								<li
									key={commit.sha}
									className="space-y-1 rounded-md border p-2"
								>
									<Button
										variant={
											selected === commit.sha
												? "secondary"
												: "ghost"
										}
										className="h-auto w-full justify-start whitespace-normal break-all text-left font-mono text-xs"
										aria-pressed={selected === commit.sha}
										onClick={() => setSelected(commit.sha)}
									>
										{commit.sha}
									</Button>
									<p className="break-words text-sm">
										{commit.message ?? t("messageWithheld")}
									</p>
									<p className="text-muted-foreground text-xs">
										{commit.author.name} ·{" "}
										<time dateTime={commit.date}>
											{Number.isNaN(
												Date.parse(commit.date),
											)
												? commit.date
												: format.dateTime(
														new Date(commit.date),
														{
															dateStyle: "medium",
															timeStyle: "short",
														},
													)}
										</time>
									</p>
									{url ? (
										<a
											className="text-sm underline"
											href={url}
											target="_blank"
											rel="noopener noreferrer"
										>
											{t("source")}
										</a>
									) : null}
								</li>
							);
						})}
					</ul>
					{history.hasNextPage ? (
						<Button
							variant="outline"
							size="sm"
							disabled={history.isFetchingNextPage}
							onClick={() => {
								void history.fetchNextPage();
							}}
						>
							{t("loadMore")}
						</Button>
					) : null}
					{lastPage?.hasMore ? (
						<p className="text-muted-foreground text-xs">
							{t(
								lastPage.historyLimitReached
									? "limit"
									: "partial",
							)}
						</p>
					) : null}
				</div>
				<div
					className="min-w-0 space-y-3 md:col-span-2"
					aria-live="polite"
				>
					{selected === null ? <p>{t("select")}</p> : null}
					{selected !== null && preview.isFetching ? (
						<Skeleton className="h-40 w-full" />
					) : null}
					{selected !== null && preview.isError ? (
						<p role="alert">
							{t("previewError")} {errorText(preview.error)}
						</p>
					) : null}
					{comparison ? (
						<>
							<p className="break-all text-sm">
								{t("selectedRevision", {
									sha: comparison.targetCommitSha,
								})}
							</p>
							<p className="text-muted-foreground text-xs">
								{t(`versionState.${comparison.current.state}`, {
									side: t("current"),
								})}
							</p>
							<p className="text-muted-foreground text-xs">
								{t(
									`versionState.${comparison.selected.state}`,
									{ side: t("selected") },
								)}
							</p>
							{(comparison.current.state === "found" ||
								comparison.current.state === "absent") &&
							(comparison.selected.state === "found" ||
								comparison.selected.state === "absent") ? (
								<InstructionDiffBody
									path={path}
									before={
										comparison.current.state === "found"
											? comparison.current.text
											: ""
									}
									after={
										comparison.selected.state === "found"
											? comparison.selected.text
											: ""
									}
									truncated={false}
								/>
							) : null}
							{!comparison.restore.available ? (
								<p>
									{t(
										`unsupported.${comparison.restore.reason}`,
									)}
								</p>
							) : null}
							<p className="text-muted-foreground text-xs">
								{t("restoreDescription")}
							</p>
							{refusal ? <p>{refusal}</p> : null}
							<Button
								disabled={
									Boolean(refusal) ||
									!comparison.restore.available
								}
								onClick={requestRestore}
							>
								{t("restore")}
							</Button>
						</>
					) : null}
					{submissionError ? (
						<p role="alert">{submissionError}</p>
					) : null}
					{stale || preview.isError ? (
						<Button variant="outline" onClick={onRefresh}>
							{t("refresh")}
						</Button>
					) : null}
				</div>
			</div>
		</div>
	);
}
