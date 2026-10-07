"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { ConnectCliDialog } from "@saas/projects/components/cli-connection/ConnectCliDialog";
import type { NativeInstructionBase } from "@saas/projects/lib/instruction-change-source";
import { safeHttpsUrl } from "@saas/projects/lib/instructions-direct-commit";
import { localSetupRouteFor } from "@saas/projects/lib/instructions-repository-sync";
import { formatRelativeTime } from "@saas/shared/lib/format-time";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { CheckIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { defaultSelectedPath } from "../../lib/instructions-default-file";
import {
	navigateToProjectSettingsTab,
	REPOSITORY_SETTINGS_ANCHOR_ID,
} from "../settings-tab-navigation";
import { AddInstructionFileDialog } from "./AddInstructionFileDialog";
import { ConfigureRepositorySyncDialog } from "./ConfigureRepositorySyncDialog";
import { InstructionFileView } from "./InstructionFileView";
import { InstructionProposals } from "./InstructionProposals";
import { InstructionsCommits } from "./InstructionsCommits";
import { InstructionsPageFrame } from "./InstructionsPageFrame";
import { InstructionsSettingsDialog } from "./InstructionsSettingsDialog";
import {
	InstructionsAgentFact,
	InstructionsStatusFact,
	InstructionsStatusFacts,
} from "./InstructionsStatusStrip";
import { InstructionsTree, type TreeFile } from "./InstructionsTree";
import { prefetchDefaultInstructionFiles } from "./lib/coding-instructions-warmup";
import { RepositorySyncSettingsSection } from "./RepositorySyncSettingsSection";
import { nativeInstructionDownloadUrl } from "./useInstructionFileContent";

const COMMITS_IDLE_DELAY_MS = 1_500;

type ReadyRepository = {
	availability: "READY";
	provider: string;
	repositoryUrl: string;
	ref: string;
	rootPath: string;
	generation: number;
	currentCommitSha: string;
};
type RepositoryState =
	| ReadyRepository
	| {
			availability:
				| "UPLOAD"
				| "MIGRATING"
				| "DISCONNECTED"
				| "CREDENTIALS_EXPIRED"
				| "NOT_FOUND"
				| "UNAVAILABLE";
	  };

function RepositoryUnavailableNotice({
	message,
	onReconnect,
	reconnectLabel,
}: {
	message: string;
	onReconnect?: () => void;
	reconnectLabel: string;
}) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4 text-sm">
			<output>{message}</output>
			{onReconnect ? (
				<Button type="button" size="sm" onClick={onReconnect}>
					{reconnectLabel}
				</Button>
			) : null}
		</div>
	);
}

type Props = {
	projectId: string;
	projectName: string;
	canConfigure: boolean;
	canEdit?: boolean;
	canReview?: boolean;
	readOnlyMode?: boolean;
	state: RepositoryState;
	refreshing: boolean;
	onRefresh: () => Promise<RepositoryState | undefined>;
};

export function DirectRepositoryInstructions(props: Props) {
	const t = useTranslations("projects.codingInstructions.direct");
	const [lastReady, setLastReady] = useState<{
		projectId: string;
		repository: ReadyRepository;
	} | null>(
		props.state.availability === "READY"
			? { projectId: props.projectId, repository: props.state }
			: null,
	);
	useEffect(() => {
		if (props.state.availability === "READY") {
			setLastReady({
				projectId: props.projectId,
				repository: props.state,
			});
		}
	}, [props.projectId, props.state]);
	const available = props.state.availability === "READY";
	const repository =
		props.state.availability === "READY"
			? props.state
			: lastReady?.projectId === props.projectId
				? lastReady.repository
				: null;
	const unavailableMessage = available
		? undefined
		: t(
				props.state.availability === "DISCONNECTED"
					? "disconnected"
					: props.state.availability === "CREDENTIALS_EXPIRED"
						? "credentialsExpired"
						: props.state.availability === "NOT_FOUND"
							? "notFound"
							: "unavailable",
			);
	const onReconnect =
		props.state.availability === "CREDENTIALS_EXPIRED"
			? () =>
					navigateToProjectSettingsTab(
						props.projectId,
						"development",
						{
							anchorId: REPOSITORY_SETTINGS_ANCHOR_ID,
						},
					)
			: undefined;
	const queryClient = useQueryClient();
	const [connectOpen, setConnectOpen] = useState(false);
	const refresh = async () => {
		const [, next] = await Promise.all([
			queryClient.invalidateQueries({
				queryKey: orpc.projects.instructions.repository.key({
					input: { projectId: props.projectId },
				}),
			}),
			props.onRefresh(),
		]);
		return next;
	};
	const [configureOpen, setConfigureOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const configuration = useQuery({
		...orpc.projects.instructions.repositorySync.get.queryOptions({
			input: { projectId: props.projectId },
		}),
		refetchOnWindowFocus: false,
	});
	const localSetup = localSetupRouteFor({
		repositoryBacked: true,
		repositoryConfirmed: configuration.isSuccess,
		configured: configuration.data?.configured ?? null,
	});
	return (
		<>
			{repository !== null ? (
				<ReadyRepositoryInstructions
					key={props.projectId}
					projectId={props.projectId}
					projectName={props.projectName}
					repository={repository}
					unavailableMessage={unavailableMessage}
					onReconnect={onReconnect}
					connectOpen={connectOpen}
					localSetup={localSetup}
					onConnectOpenChange={setConnectOpen}
					canEdit={available && (props.canEdit ?? false)}
					canReview={available && (props.canReview ?? false)}
					canRead={available && configuration.isSuccess}
					allowReaderProposals={
						available &&
						(configuration.data?.configured?.allowReaderProposals ??
							false)
					}
					readOnlyMode={props.readOnlyMode ?? false}
					refreshing={props.refreshing}
					onRefresh={refresh}
					onOpenSettings={() => setSettingsOpen(true)}
					repositoryLabel={
						configuration.data?.configured
							? `${configuration.data.configured.repositoryOwner}/${configuration.data.configured.repositoryName}`
							: null
					}
				/>
			) : (
				<InstructionsPageFrame
					actions={{
						syncNow: {
							running: false,
							busy: props.refreshing,
							onSync: refresh,
							label: t("refresh"),
						},
						settings: { onOpen: () => setSettingsOpen(true) },
					}}
				>
					<RepositoryUnavailableNotice
						message={unavailableMessage ?? ""}
						onReconnect={onReconnect}
						reconnectLabel={t("reconnect")}
					/>
				</InstructionsPageFrame>
			)}
			<InstructionsSettingsDialog
				projectId={props.projectId}
				open={settingsOpen}
				onOpenChange={(open) => {
					setSettingsOpen(open);
					if (!open) {
						refresh();
					}
				}}
				canEdit={props.canConfigure}
				repositoryMode
				repositorySection={
					configuration.data ? (
						<RepositorySyncSettingsSection
							projectId={props.projectId}
							state={{
								...configuration.data,
								canConfigure:
									props.canConfigure &&
									configuration.data.canConfigure,
							}}
							directRepository
							onChange={() => {
								setSettingsOpen(false);
								setConfigureOpen(true);
							}}
							onChanged={async () => {
								refresh();
								await configuration.refetch();
							}}
						/>
					) : null
				}
			/>
			{configureOpen && configuration.isPending ? (
				<output>{t("loading")}</output>
			) : null}
			{configureOpen && configuration.isError ? (
				<p role="alert">{t("loadError")}</p>
			) : null}
			{configureOpen &&
			props.canConfigure &&
			configuration.data?.canConfigure ? (
				<ConfigureRepositorySyncDialog
					projectId={props.projectId}
					open
					onOpenChange={setConfigureOpen}
					integrations={configuration.data.availableIntegrations}
					current={configuration.data.configured}
					onSaved={refresh}
				/>
			) : null}
		</>
	);
}

function ReadyRepositoryInstructions({
	projectId,
	projectName,
	repository,
	unavailableMessage,
	onReconnect,
	connectOpen,
	localSetup,
	onConnectOpenChange,
	canEdit,
	canReview,
	canRead,
	allowReaderProposals,
	readOnlyMode,
	refreshing,
	onRefresh,
	onOpenSettings,
	repositoryLabel,
}: {
	projectId: string;
	projectName: string;
	repository: ReadyRepository;
	unavailableMessage?: string;
	onReconnect?: () => void;
	connectOpen: boolean;
	localSetup: ReturnType<typeof localSetupRouteFor>;
	onConnectOpenChange: (open: boolean) => void;
	canEdit: boolean;
	canReview: boolean;
	canRead: boolean;
	allowReaderProposals: boolean;
	readOnlyMode: boolean;
	refreshing: boolean;
	onRefresh: () => Promise<RepositoryState | undefined>;
	onOpenSettings: () => void;
	repositoryLabel: string | null;
}) {
	const t = useTranslations("projects.codingInstructions.direct");
	const tPublished = useTranslations(
		"projects.codingInstructions.publishedView",
	);
	const { organizationId, organizationSlug, isGuest } =
		useOrganizationContext();
	const [history, setHistory] = useState<"commits" | "proposals" | null>(
		null,
	);
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [addOpen, setAddOpen] = useState(false);
	const [leftOutShown, setLeftOutShown] = useState(false);
	const [treeHasNoMatches, setTreeHasNoMatches] = useState(false);
	const fileListRef = useRef<TreeFile[]>([]);
	const [draftOwner, setDraftOwner] = useState<{
		nativeBase: NativeInstructionBase;
		path: string;
		files: TreeFile[];
	} | null>(null);
	const onNativeDraftStateChange = useCallback(
		(draft: { nativeBase: NativeInstructionBase; path: string } | null) =>
			setDraftOwner((previous) =>
				previous?.path === draft?.path &&
				previous?.nativeBase.generation ===
					draft?.nativeBase.generation &&
				previous?.nativeBase.commitSha === draft?.nativeBase.commitSha
					? previous
					: draft
						? { ...draft, files: fileListRef.current }
						: null,
			),
		[],
	);
	const pin = {
		generation: repository.generation,
		commitSha: repository.currentCommitSha,
	};
	const files = useQuery({
		...orpc.projects.instructions.repository.listFiles.queryOptions({
			input: { projectId, ...pin },
		}),
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
		enabled: unavailableMessage === undefined,
	});
	const queryClient = useQueryClient();
	const pinGeneration = pin.generation;
	const pinCommitSha = pin.commitSha;
	const readable = unavailableMessage === undefined;
	useEffect(() => {
		if (readable) {
			prefetchDefaultInstructionFiles(queryClient, projectId, {
				generation: pinGeneration,
				commitSha: pinCommitSha,
			});
		}
	}, [readable, queryClient, projectId, pinGeneration, pinCommitSha]);
	// The commit list only decorates the header ("published by"), so it waits
	// until the file is on screen, or until History is opened.
	const [commitsIdle, setCommitsIdle] = useState(false);
	const filesLoaded = files.data !== undefined;
	useEffect(() => {
		if (!filesLoaded) {
			return;
		}
		const timer = setTimeout(
			() => setCommitsIdle(true),
			COMMITS_IDLE_DELAY_MS,
		);
		return () => clearTimeout(timer);
	}, [filesLoaded]);
	const commits = useQuery({
		...orpc.projects.instructions.repository.listCommits.queryOptions({
			input: { projectId, ...pin, cursor: 1 },
		}),
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
		enabled: readable && (commitsIdle || history === "commits"),
	});
	if (files.data) fileListRef.current = files.data.files;
	const listing =
		files.data ??
		(draftOwner
			? { files: draftOwner.files, incomplete: false, refusal: null }
			: undefined);
	const head = commits.data?.commits.find(
		(commit) => commit.sha === pin.commitSha,
	);
	const repositoryUrl = safeHttpsUrl(repository.repositoryUrl);
	const selectedFile =
		files.data === undefined
			? null
			: selectedPath !== null &&
					files.data.files.some((file) => file.path === selectedPath)
				? selectedPath
				: defaultSelectedPath(files.data.files);
	const refreshWithFeedback = async () => {
		const next = await onRefresh();
		if (next?.availability !== "READY") {
			return;
		}
		toast.info(
			next.currentCommitSha === pin.commitSha
				? t("refreshUpToDate")
				: t("refreshUpdated", {
						sha7: next.currentCommitSha.slice(0, 7),
					}),
		);
	};
	const badgeText = tPublished("publishedBadgeRepository", {
		ref: repository.ref,
		sha7: pin.commitSha.slice(0, 7),
	});
	const viewPath = draftOwner?.path ?? selectedFile;
	const viewBase = draftOwner?.nativeBase ?? pin;
	const canCommit = canEdit && !readOnlyMode;
	const canPropose = canEdit || (canRead && allowReaderProposals);
	const repositoryTarget = {
		repository: repositoryLabel ?? repository.ref,
		ref: repository.ref,
	};
	return (
		<InstructionsPageFrame
			actions={{
				history: { commits: true, onOpen: () => setHistory("commits") },
				download: {
					pending: files.isPending,
					onDownload: () => {
						window.location.assign(
							nativeInstructionDownloadUrl({
								projectId,
								nativeBase: pin,
							}),
						);
					},
				},
				proposals: {
					label: "proposalsButton",
					onOpen: () => setHistory("proposals"),
				},
				syncNow: {
					running: false,
					busy: refreshing,
					onSync: () => void refreshWithFeedback(),
					label: t("refresh"),
				},
				settings: { onOpen: onOpenSettings },
				addFile:
					canCommit || canPropose
						? { mode: "suggest", onOpen: () => setAddOpen(true) }
						: undefined,
			}}
			badge={
				<span
					data-testid="instructions-branch-pill"
					title={badgeText}
					className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-0.5 font-medium text-success text-xs"
				>
					<CheckIcon className="size-3 shrink-0" aria-hidden="true" />
					<span className="truncate">{badgeText}</span>
				</span>
			}
		>
			{unavailableMessage ? (
				<RepositoryUnavailableNotice
					message={unavailableMessage}
					onReconnect={onReconnect}
					reconnectLabel={t("reconnect")}
				/>
			) : null}
			<InstructionsStatusFacts>
				<InstructionsStatusFact label={tPublished("statusSource")}>
					{repositoryUrl ? (
						<a
							href={repositoryUrl}
							target="_blank"
							rel="noopener noreferrer"
							className="hover:underline"
						>
							{tPublished("statusSourceRepository", {
								repository:
									repositoryLabel ??
									tPublished("repositoryUnknown"),
								ref: repository.ref,
							})}
						</a>
					) : (
						repository.ref
					)}
				</InstructionsStatusFact>
				<InstructionsStatusFact label={tPublished("statusPublished")}>
					{head ? (
						tPublished("statusPublishedBy", {
							name: head.author.name,
							time: formatRelativeTime(head.date),
						})
					) : (
						<code>{pin.commitSha.slice(0, 7)}</code>
					)}
				</InstructionsStatusFact>
				<InstructionsStatusFact label={t("filesLabel")}>
					{files.data
						? tPublished("statusFiles", {
								count: files.data.files.length,
							})
						: t("loading")}
				</InstructionsStatusFact>
				<InstructionsAgentFact
					onConnect={
						organizationId && !isGuest
							? () => onConnectOpenChange(true)
							: undefined
					}
				/>
				{files.data && files.data.excludedCount > 0 ? (
					<InstructionsStatusFact label={tPublished("statusLeftOut")}>
						<span>
							{tPublished("statusFiles", {
								count: files.data.excludedCount,
							})}
						</span>
						<Button
							variant="link"
							size="sm"
							aria-pressed={leftOutShown}
							onClick={() => setLeftOutShown((shown) => !shown)}
						>
							{tPublished(
								leftOutShown
									? "statusHideLeftOut"
									: "statusShowLeftOut",
							)}
						</Button>
						{leftOutShown &&
						files.data.excludedPaths.length <
							files.data.excludedCount ? (
							<span className="text-muted-foreground text-xs">
								{tPublished("statusLeftOutPartial", {
									shown: files.data.excludedPaths.length,
								})}
							</span>
						) : null}
					</InstructionsStatusFact>
				) : null}
			</InstructionsStatusFacts>
			{!listing ? (
				<output>{t("loading")}</output>
			) : (files.isError || listing.refusal) && !draftOwner ? (
				<p role="alert">{t("loadError")}</p>
			) : (
				<>
					{listing.incomplete ? (
						<p className="text-muted-foreground text-sm">
							{t("incomplete")}
						</p>
					) : null}
					{listing.files.length === 0 && !draftOwner ? (
						<p className="rounded-lg border p-6 text-sm">
							{t("empty")}
						</p>
					) : (
						<div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)] xl:grid-cols-[340px_minmax(0,1fr)]">
							<div
								data-onboarding-target="coding-instructions-tree"
								className="min-w-0"
							>
								<InstructionsTree
									files={listing.files}
									leftOut={
										files.data &&
										files.data.excludedCount > 0
											? {
													files: files.data
														.excludedPaths,
													shown: leftOutShown,
													onToggle: () =>
														setLeftOutShown(
															(shown) => !shown,
														),
												}
											: undefined
									}
									selectedPath={selectedFile}
									onSelect={setSelectedPath}
									onNoMatchesChange={setTreeHasNoMatches}
								/>
							</div>
							<div
								data-onboarding-target="coding-instructions-file-view"
								className="min-w-0 overflow-hidden rounded-lg border bg-card"
							>
								{treeHasNoMatches ? (
									<p className="p-6 text-muted-foreground text-sm">
										{t("searchNoMatches")}
									</p>
								) : null}
								<div
									className={
										treeHasNoMatches ? "hidden" : undefined
									}
								>
									{viewPath ? (
										<InstructionFileView
											projectId={projectId}
											nativeBase={viewBase}
											currentNativeBase={pin}
											path={viewPath}
											nativeFile={files.data?.files.find(
												(file) =>
													file.path === viewPath,
											)}
											canCommit={canCommit}
											canPropose={canPropose}
											repositoryTarget={repositoryTarget}
											existingPaths={
												new Set(
													listing.files.map(
														(file) => file.path,
													),
												)
											}
											onChanged={onRefresh}
											onCommitted={onRefresh}
											onNativeDraftStateChange={
												onNativeDraftStateChange
											}
										/>
									) : (
										<p className="p-6 text-muted-foreground text-sm">
											{t("selectFile")}
										</p>
									)}
								</div>
							</div>
						</div>
					)}
				</>
			)}
			<p className="text-muted-foreground text-xs">{t("readOnly")}</p>
			{history === "commits" ? (
				<InstructionsCommits
					projectId={projectId}
					open
					onOpenChange={(open) => {
						if (!open) {
							setHistory(null);
						}
					}}
					provider={repository.provider}
					branch={repository.ref}
					rootPath={repository.rootPath}
					published={{ sha: pin.commitSha, version: null }}
					repositoryPin={pin}
					canRevert={canEdit && !readOnlyMode}
					canCompare={canEdit}
					onChanged={onRefresh}
				/>
			) : null}
			{addOpen ? (
				<AddInstructionFileDialog
					projectId={projectId}
					nativeBase={pin}
					open
					onOpenChange={setAddOpen}
					folder={null}
					proposalOnly={!canCommit}
					canCommit={canCommit}
					canPropose={canPropose}
					repositoryTarget={repositoryTarget}
					onAdded={onRefresh}
					onCommitted={onRefresh}
				/>
			) : null}
			{history === "proposals" ? (
				<InstructionProposals
					projectId={projectId}
					open
					onOpenChange={(open) => {
						if (!open) setHistory(null);
					}}
					onChanged={onRefresh}
					canReview={canReview}
					canDecide={false}
					repositoryBacked
					repositoryProvider={repository.provider}
				/>
			) : null}
			{organizationId ? (
				<ConnectCliDialog
					open={connectOpen}
					onOpenChange={onConnectOpenChange}
					organizationId={organizationId}
					organizationSlug={organizationSlug ?? undefined}
					projectId={projectId}
					projectName={projectName}
					purpose="coding-instructions"
					localSetup={localSetup}
				/>
			) : null}
		</InstructionsPageFrame>
	);
}
