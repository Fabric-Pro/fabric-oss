"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { ConnectCliDialog } from "@saas/projects/components/cli-connection/ConnectCliDialog";
import type { NativeInstructionBase } from "@saas/projects/lib/instruction-change-source";
import { safeHttpsUrl } from "@saas/projects/lib/instructions-direct-commit";
import { instructionsFreshness } from "@saas/projects/lib/instructions-query-freshness";
import { localSetupRouteFor } from "@saas/projects/lib/instructions-repository-sync";
import { formatRelativeTime } from "@saas/shared/lib/format-time";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Skeleton } from "@ui/components/skeleton";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { defaultSelectedPath } from "../../lib/instructions-default-file";
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
import { type RepositoryLinks, repositoryWebUrl } from "./instruction-links";
import { RepositoryHeaderBadge } from "./RepositoryHeaderBadge";
import { RepositorySyncSettingsSection } from "./RepositorySyncSettingsSection";
import {
	type RepositoryUnavailability,
	RepositoryUnavailableNotice,
} from "./RepositoryUnavailableNotice";
import { nativeInstructionDownloadUrl } from "./useInstructionFileContent";
import { useRenameFollowing } from "./useRenameFollowing";
import { useRepositoryReads, useRereadOpenFile } from "./useRepositoryReads";

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
	| { availability: "UPLOAD" | "MIGRATING" | RepositoryUnavailability };

type Props = {
	projectId: string;
	projectName: string;
	canConfigure: boolean;
	canEdit?: boolean;
	canReview?: boolean;
	readOnlyMode?: boolean;
	state: RepositoryState;
	refreshing: boolean;
	/** Re-reads the repository state once; the answer reaches `state`. */
	onRefresh: () => Promise<void>;
	/** The state, then the reads at the current commit: after a setting changed what they show. */
	onReread: () => Promise<void>;
	/** The Refresh button: the same re-read, then says what it found. */
	onUserRefresh: () => Promise<void>;
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
	const unavailable: RepositoryUnavailability | null =
		props.state.availability === "READY" ||
		props.state.availability === "UPLOAD" ||
		props.state.availability === "MIGRATING"
			? null
			: props.state.availability;
	const [connectOpen, setConnectOpen] = useState(false);
	const [configureOpen, setConfigureOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const settingsChanged = useRef(false);
	// Every way the settings dialog closes ends here, so a save is re-read
	// once and the flag never outlives the dialog.
	const finishSettings = () => {
		if (settingsChanged.current) {
			settingsChanged.current = false;
			void props.onReread();
		}
	};
	const configuration = useQuery({
		...orpc.projects.instructions.repositorySync.get.queryOptions({
			input: { projectId: props.projectId },
		}),
		...instructionsFreshness.configurationRead,
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
					unavailable={unavailable}
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
					onRefresh={props.onRefresh}
					onUserRefresh={props.onUserRefresh}
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
							onSync: props.onUserRefresh,
							label: t("refresh"),
						},
						settings: { onOpen: () => setSettingsOpen(true) },
					}}
				>
					{unavailable ? (
						<RepositoryUnavailableNotice
							projectId={props.projectId}
							availability={unavailable}
						/>
					) : null}
				</InstructionsPageFrame>
			)}
			<InstructionsSettingsDialog
				projectId={props.projectId}
				open={settingsOpen}
				onSaved={() => {
					settingsChanged.current = true;
				}}
				onOpenChange={(open) => {
					setSettingsOpen(open);
					if (!open) {
						finishSettings();
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
								finishSettings();
								setConfigureOpen(true);
							}}
							onChanged={async () => {
								settingsChanged.current = true;
								props.onRefresh().catch(() => undefined);
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
					onSaved={props.onReread}
				/>
			) : null}
		</>
	);
}

function ReadyRepositoryInstructions({
	projectId,
	projectName,
	repository,
	unavailable,
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
	onUserRefresh,
	onOpenSettings,
	repositoryLabel,
}: {
	projectId: string;
	projectName: string;
	repository: ReadyRepository;
	unavailable: RepositoryUnavailability | null;
	connectOpen: boolean;
	localSetup: ReturnType<typeof localSetupRouteFor>;
	onConnectOpenChange: (open: boolean) => void;
	canEdit: boolean;
	canReview: boolean;
	canRead: boolean;
	allowReaderProposals: boolean;
	readOnlyMode: boolean;
	refreshing: boolean;
	onRefresh: () => Promise<void>;
	onUserRefresh: () => Promise<void>;
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
	const readable = unavailable === null;
	const { files, commits, defaultPath } = useRepositoryReads({
		projectId,
		pin,
		readable,
		historyOpen: history === "commits",
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
	const repositoryLinks: RepositoryLinks | null = repositoryUrl
		? {
				provider: repository.provider,
				repositoryUrl,
				ref: repository.ref,
				rootPath: repository.rootPath,
			}
		: null;
	const renameFollow = useRenameFollowing({
		paths: files.data?.files.map((file) => file.path),
		pin,
		onLanded: setSelectedPath,
	});
	const wantedPath = renameFollow.landedPath ?? selectedPath;
	const selectedFile =
		files.data === undefined
			? (wantedPath ?? defaultPath ?? null)
			: wantedPath !== null &&
					files.data.files.some((file) => file.path === wantedPath)
				? wantedPath
				: defaultSelectedPath(files.data.files);
	const viewPath =
		draftOwner?.path ?? renameFollow.waiting?.from ?? selectedFile;
	const rereadOpenFile = useRereadOpenFile({
		projectId,
		path: viewPath,
		onRefresh,
	});
	const viewBase = draftOwner?.nativeBase ?? renameFollow.waiting?.pin ?? pin;
	const selectPath = useCallback(
		(path: string) => {
			if (draftOwner && path !== draftOwner.path) {
				toast.info(t("finishEditingFirst"));
				return;
			}
			setSelectedPath(path);
		},
		[draftOwner, t],
	);
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
					onSync: onUserRefresh,
					label: t("refresh"),
				},
				settings: { onOpen: onOpenSettings },
				addFile:
					canCommit || canPropose
						? { mode: "suggest", onOpen: () => setAddOpen(true) }
						: undefined,
			}}
			badge={
				<RepositoryHeaderBadge
					branch={repository.ref}
					commitSha={pin.commitSha}
				/>
			}
		>
			{unavailable ? (
				<RepositoryUnavailableNotice
					projectId={projectId}
					availability={unavailable}
				/>
			) : null}
			<InstructionsStatusFacts>
				<InstructionsStatusFact label={tPublished("statusSource")}>
					{repositoryUrl ? (
						<a
							href={
								repositoryLinks
									? repositoryWebUrl(repositoryLinks)
									: repositoryUrl
							}
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
									total: files.data.excludedCount,
								})}
							</span>
						) : null}
					</InstructionsStatusFact>
				) : null}
			</InstructionsStatusFacts>
			{!listing && viewPath === null ? (
				<output>{t("loading")}</output>
			) : (files.isError || listing?.refusal) && !draftOwner ? (
				<div role="alert" className="flex flex-wrap items-center gap-3">
					<p>{t("loadError")}</p>
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={() => void files.refetch()}
					>
						{t("retryLoad")}
					</Button>
				</div>
			) : (
				<>
					{listing?.incomplete ? (
						<p className="text-muted-foreground text-sm">
							{t("incomplete")}
						</p>
					) : null}
					{listing && listing.files.length === 0 && !draftOwner ? (
						<p className="rounded-lg border p-6 text-sm">
							{t("empty")}
						</p>
					) : (
						<div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)] xl:grid-cols-[340px_minmax(0,1fr)]">
							<div className="min-w-0">
								{listing ? (
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
																(shown) =>
																	!shown,
															),
													}
												: undefined
										}
										selectedPath={viewPath}
										onSelect={selectPath}
									/>
								) : (
									<Skeleton
										className="h-64 w-full rounded-lg"
										aria-hidden="true"
										data-onboarding-target="coding-instructions-tree"
									/>
								)}
							</div>
							<div
								data-onboarding-target="coding-instructions-file-view"
								className="min-w-0 overflow-hidden rounded-lg border bg-card"
							>
								{viewPath ? (
									<InstructionFileView
										projectId={projectId}
										nativeBase={viewBase}
										currentNativeBase={pin}
										path={viewPath}
										nativeFile={files.data?.files.find(
											(file) => file.path === viewPath,
										)}
										canCommit={
											canCommit && listing !== undefined
										}
										canPropose={
											canPropose && listing !== undefined
										}
										repositoryTarget={repositoryTarget}
										repositoryLinks={repositoryLinks}
										onOpenPath={selectPath}
										onRenamed={(to) =>
											renameFollow.begin(viewPath, to)
										}
										existingPaths={
											new Set(
												listing?.files.map(
													(file) => file.path,
												),
											)
										}
										onChanged={onRefresh}
										onCommitted={rereadOpenFile}
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
