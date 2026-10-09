"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import {
	type Query,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { InstructionMigrationRepositoryProvider } from "../../hooks/instruction-migration-repository";
import { useRepositoryMigration } from "../../hooks/use-repository-migration";
import { useSyncActionError } from "../../hooks/use-sync-action-error";
import {
	instructionsAwaitsCommitSync,
	instructionsAwaitsPublish,
	instructionsPollInterval,
} from "../../lib/instructions-poll";
import { instructionsFreshness } from "../../lib/instructions-query-freshness";
import {
	latestSyncRunChanged,
	localSetupRouteFor,
	offersMoveIntoRepository,
	REPOSITORY_SYNC_POLL_MS,
	type RepositorySyncControls,
	type RepositorySyncState,
	repositorySyncPollInterval,
	type SyncNowResult,
	syncNowResultMessage,
	syncRunEnded,
} from "../../lib/instructions-repository-sync";
import { ConfigureRepositorySyncDialog } from "./ConfigureRepositorySyncDialog";
import { DirectRepositoryInstructions } from "./DirectRepositoryInstructions";
import { InstructionsEmptyState } from "./InstructionsEmptyState";
import {
	InstructionsPublishedView,
	type InstructionsSnapshot,
} from "./InstructionsPublishedView";
import { InstructionsSettingsNotice } from "./InstructionsSettingsNotice";
import {
	InstructionsLoadError,
	InstructionsTabSkeleton,
} from "./InstructionsTabState";
import { MoveInstructionsDialog } from "./MoveInstructionsDialog";
import { UploadFolderDialog } from "./UploadFolderDialog";

/** Whether a cached read was made for exactly this commit pin. */
function isReadAtPin(
	query: Query,
	generation: number,
	commitSha: string,
): boolean {
	const options = query.queryKey[1];
	if (typeof options !== "object" || options === null) {
		return false;
	}
	const input = "input" in options ? options.input : null;
	return (
		typeof input === "object" &&
		input !== null &&
		"commitSha" in input &&
		input.commitSha === commitSha &&
		"generation" in input &&
		input.generation === generation
	);
}

/**
 * Whether a cached read is one of the commit-pinned repository reads (files,
 * file bodies, commits) rather than the repository state itself.
 */
function isPinnedRepositoryRead(query: Query): boolean {
	const procedure = query.queryKey[0];
	return Array.isArray(procedure) && procedure.at(-1) !== "getState";
}

/**
 * The four fields the polling decision reads off a snapshot row. Declared
 * here rather than inferred from the query, because both `refetchInterval`
 * closures are built before their own query's data exists.
 *
 * `createdAt` is what retires a RECEIVING row whose upload was abandoned:
 * `finalize` was never called, so no workflow will ever move it and there is
 * nothing to wait for (see `instructions-poll.ts`). `deferredScanStatus` and
 * `readyAt` keep the poll going while a version published before its secret
 * scan waits for that scan's verdict (Fizzy #2737).
 */
type PollSnapshot = {
	id: string;
	status: string;
	publishOnReady?: boolean;
	createdAt?: string | Date | null;
	deferredScanStatus?: string | null;
	readyAt?: string | Date | null;
	/** The commit a synced version was taken from: what a commit made here is waited for by. */
	sourceCommitSha?: string | null;
};

type CodingInstructionsTabProps = {
	projectId: string;
	projectName: string;
	canEdit?: boolean;
	canReview?: boolean;
	readOnlyMode?: boolean;
};

export function CodingInstructionsTab(props: CodingInstructionsTabProps) {
	const t = useTranslations("projects.codingInstructions.direct");
	const queryClient = useQueryClient();
	const repository = useQuery({
		...orpc.projects.instructions.repository.getState.queryOptions({
			input: { projectId: props.projectId },
		}),
		// A draft in progress keeps its own base and shows the "newer commit"
		// notice instead of changing under it.
		...instructionsFreshness.liveRepositoryState,
	});
	// Re-reads the repository state after something this tab did. It always
	// starts a fresh request (a poll that began before the action would answer
	// with the old head) and is shared only by the callers of the same action,
	// which run back to back: a commit announces itself through both
	// `onChanged` and `onCommitted`.
	type StateRead = { data: typeof repository.data; failed: boolean };
	const postAction = useRef<Promise<StateRead> | null>(null);
	const refreshState = () => {
		if (postAction.current === null) {
			postAction.current = repository.refetch().then((result) => ({
				data: result.data,
				failed: result.isError,
			}));
			setTimeout(() => {
				postAction.current = null;
			}, 0);
		}
		return postAction.current;
	};
	// The state read, then every read pinned to the commit it names: a pinned
	// read is keyed by its sha, so a head that did not move would otherwise
	// keep a stale list (settings changed what the tree shows) or a failed
	// read. A head that moved has new keys and nothing to invalidate. When
	// the state read fails, the pin is the last known one: a user's refresh
	// invalidates nothing (the state it kept is the old one), but after a
	// change this tab made (`changedTree`) the old pin's reads are stale
	// all the same, since such a change never moves the head.
	const rereadPin = async (changedTree = false): Promise<StateRead> => {
		const read = await refreshState();
		const next = read.data;
		if ((!read.failed || changedTree) && next?.availability === "READY") {
			await queryClient.invalidateQueries({
				queryKey: orpc.projects.instructions.repository.key({
					input: { projectId: props.projectId },
				}),
				predicate: (query) =>
					isPinnedRepositoryRead(query) &&
					isReadAtPin(query, next.generation, next.currentCommitSha),
			});
		}
		return read;
	};
	const refreshWithFeedback = async () => {
		const before = repository.data;
		const { data: next, failed } = await rereadPin();
		if (failed) {
			toast.error(t("refreshFailed"));
			return;
		}
		if (next?.availability !== "READY") {
			return;
		}
		toast.info(
			before?.availability === "READY" &&
				before.currentCommitSha === next.currentCommitSha
				? t("refreshUpToDate")
				: t("refreshUpdated", {
						sha7: next.currentCommitSha.slice(0, 7),
					}),
		);
	};
	if (repository.isPending) {
		return <InstructionsTabSkeleton />;
	}
	if (repository.isError && repository.data === undefined) {
		return (
			<InstructionsLoadError
				retrying={repository.isFetching}
				onRetry={() => void repository.refetch()}
			/>
		);
	}
	const state = repository.data;
	if (state.availability === "UPLOAD" || state.availability === "MIGRATING") {
		return <SnapshotCodingInstructionsTab {...props} />;
	}
	return (
		<DirectRepositoryInstructions
			key={props.projectId}
			projectId={props.projectId}
			projectName={props.projectName}
			canConfigure={(props.canEdit ?? false) && !props.readOnlyMode}
			canEdit={props.canEdit ?? false}
			canReview={props.canReview ?? false}
			readOnlyMode={props.readOnlyMode ?? false}
			state={state}
			refreshing={repository.isFetching}
			onRefresh={async () => {
				const read = await refreshState();
				if (read.failed) {
					throw new Error("repository state read failed");
				}
			}}
			onReread={async () => {
				const read = await rereadPin(true);
				if (read.failed) {
					toast.error(t("refreshFailed"));
				}
			}}
			onUserRefresh={refreshWithFeedback}
		/>
	);
}

function SnapshotCodingInstructionsTab({
	projectId,
	projectName,
	canEdit = false,
	canReview = false,
	readOnlyMode = false,
}: {
	projectId: string;
	/** Threaded down to the "Connect your agent" dialog's starter instruction. */
	projectName: string;
	/**
	 * Whether this viewer's project role may change the published files
	 * (Edit, Delete file, Add file). A UI gate only: `derive` re-checks
	 * `INSTRUCTION_CREATE` and the project's source of truth server-side on
	 * every save.
	 */
	canEdit?: boolean;
	/** Whether this viewer may approve or reject reader proposals. */
	canReview?: boolean;
	/**
	 * The project is in Read-only mode, which refuses every write to its
	 * connected sources, a commit to the synced branch included. A UI gate:
	 * the server refuses either way.
	 */
	readOnlyMode?: boolean;
}) {
	const queryClient = useQueryClient();
	const [uploadOpen, setUploadOpen] = useState(false);
	const [configureOpen, setConfigureOpen] = useState(false);
	const [moveOpen, setMoveOpen] = useState(false);
	const tSync = useTranslations("projects.codingInstructions.repositorySync");
	// When this tab was opened, so the poll can slow down rather than stay at
	// 3s indefinitely. A ref, not state: changing it must never re-render.
	const mountedAt = useRef(Date.now());
	// When this tab first SAW the newest snapshot reach READY, and which
	// snapshot that was. The client's own clock, not the row's server-written
	// `readyAt` (see `instructionsAwaitsPublish`).
	//
	// STATE rather than a ref, and load-bearing that it is: React Query
	// recomputes a query's `refetchInterval` when that query's own state
	// changes or when the component re-renders, and a list whose poll has just
	// been turned off by a terminal status does neither. Writing this to a ref
	// left the restart with nothing to trigger it — the value was right and
	// nothing ever read it again.
	const [readySeen, setReadySeen] = useState<{
		snapshotId: string;
		at: number;
	} | null>(null);
	// The commit this tab's own editor just made, until Fabric's copy has taken
	// it (Fizzy #2878 §10). `committed` records the push; the published
	// pointer follows from a sync run of the branch's real tree, so the tab
	// keeps reading until the published row names that commit, for a bounded
	// time, and says "Fabric's copy is syncing" meanwhile.
	const [awaitedCommit, setAwaitedCommit] = useState<{
		sha: string;
		ref: string;
		at: number;
	} | null>(null);
	// The last rendered list and published pointer, so that BOTH queries'
	// intervals can be decided from both. Refs because each query's own
	// `refetchInterval` can run outside a render (on that query's state
	// change), and because a query whose result is deeply equal to the last one
	// does not re-render at all.
	const snapshotsRef = useRef<PollSnapshot[] | undefined>(undefined);
	const publishedIdRef = useRef<string | null>(null);
	// The pointer row itself, for the same reason: its own pending deferred
	// scan keeps both queries polling (`instructionsPollInterval`).
	const publishedRowRef = useRef<PollSnapshot | null>(null);
	// Whether a repository sync run is open, for the list's own interval: a
	// run creates its snapshot from a worker, and until that row exists
	// nothing in the list is in flight to keep the poll going.
	const syncRunningRef = useRef(false);
	const latestSyncRunRef = useRef<{
		snapshotId: string | null;
		status: string | null;
	} | null>(null);
	const awaitedCommitRef = useRef(awaitedCommit);
	awaitedCommitRef.current = awaitedCommit;
	// The last `running` this tab saw, to notice a run closing.
	const wasSyncRunningRef = useRef(false);
	// The last latest-run id this tab saw, to notice a run that started and
	// finished between two idle reads (Decision 39). `undefined` until the
	// sync state first loads.
	const lastSyncRunIdRef = useRef<string | null | undefined>(undefined);

	/**
	 * Poll while validation is running, and then while auto-publication is
	 * still catching up: the workflow writes READY one activity before it
	 * moves the project's published pointer, so stopping on READY left a
	 * first upload showing "nothing published" and a replacement showing the
	 * old tree until the viewer reloaded.
	 */
	const pollInterval = (snapshots: PollSnapshot[] | undefined) => {
		const now = Date.now();
		const elapsedMs = now - mountedAt.current;
		const interval = instructionsPollInterval(snapshots, elapsedMs, {
			now,
			published: publishedRowRef.current,
			awaitingCommitSync: instructionsAwaitsCommitSync({
				awaited: awaitedCommitRef.current,
				publishedSha: publishedRowRef.current?.sourceCommitSha,
				now,
			}),
			awaitingPublish: instructionsAwaitsPublish({
				snapshots,
				publishedId: publishedIdRef.current,
				latestSyncRun: latestSyncRunRef.current,
				readySince:
					readySeen && readySeen.snapshotId === snapshots?.[0]?.id
						? readySeen.at
						: null,
				now,
				elapsedMs,
			}),
		});
		return interval === false && syncRunningRef.current
			? REPOSITORY_SYNC_POLL_MS
			: interval;
	};

	// Whether the tab is still waiting for the published pointer to catch up
	// with a version that passed its checks, read at render for the
	// "Publishing..." pill. The same bounded answer the poll uses, so the pill
	// goes when the polling does.
	const awaitsPublishAt = (now: number) =>
		instructionsAwaitsPublish({
			snapshots: snapshotsRef.current,
			publishedId: publishedIdRef.current,
			latestSyncRun: latestSyncRunRef.current,
			readySince:
				readySeen &&
				readySeen.snapshotId === snapshotsRef.current?.[0]?.id
					? readySeen.at
					: null,
			now,
			elapsedMs: now - mountedAt.current,
		});

	const published = useQuery({
		...orpc.projects.instructions.getPublished.queryOptions({
			input: { projectId },
		}),
		// The pointer is polled on the same schedule as the list, so the tree
		// converges on the published snapshot rather than waiting for a
		// refocus. Both are `false` as soon as nothing is in flight.
		refetchInterval: () => pollInterval(snapshotsRef.current),
	});
	const latest = useQuery({
		...orpc.projects.instructions.list.queryOptions({
			input: { projectId },
		}),
		// Terminal statuses (REJECTED/FAILED) stop the poll; a snapshot still
		// in flight is re-read every 3s for the first two minutes and every
		// 30s after that; READY keeps it going for a bounded run of further
		// polls until the pointer moves. See `instructions-poll.ts`.
		refetchInterval: (query) =>
			pollInterval(query.state.data as PollSnapshot[] | undefined),
	});
	const settings = useQuery(
		orpc.projects.instructions.getSettings.queryOptions({
			input: { projectId },
		}),
	);
	const syncQuery =
		orpc.projects.instructions.repositorySync.get.queryOptions({
			input: { projectId },
		});
	const repositorySync = useQuery({
		...syncQuery,
		// Every 3 s while a run is open (§7.1); every 60 s while automatic
		// sync is on and not paused, to find runs the scheduled check or a
		// push started (Decision 39); not at all otherwise.
		refetchInterval: (query) =>
			repositorySyncPollInterval(
				query.state.data as RepositorySyncState | undefined,
			),
	});
	const syncState = repositorySync.data as RepositorySyncState | undefined;
	// While a move into a repository is open, the sync is the one the move
	// created: its repository is what every paused action names.
	const migrationRepository =
		syncState?.migration && syncState.configured
			? `${syncState.configured.repositoryOwner}/${syncState.configured.repositoryName}`
			: null;
	const syncActionError = useSyncActionError(migrationRepository);
	const syncRunning = syncState?.running ?? false;
	syncRunningRef.current = syncRunning;
	latestSyncRunRef.current = syncState?.latestRun ?? null;
	const latestSyncRunId = syncState
		? (syncState.latestRun?.id ?? null)
		: undefined;
	const syncNow = useMutation(
		orpc.projects.instructions.repositorySync.syncNow.mutationOptions({
			onSuccess: (result) => {
				const announced = syncNowResultMessage(result as SyncNowResult);
				toast[announced.tone](tSync(announced.key));
				queryClient.invalidateQueries({ queryKey: syncQuery.queryKey });
			},
			onError: (error) => toast.error(syncActionError(error, "syncNow")),
		}),
	);

	snapshotsRef.current = latest.data as PollSnapshot[] | undefined;
	publishedIdRef.current =
		(published.data as { id?: string } | null | undefined)?.id ?? null;
	publishedRowRef.current =
		(published.data as PollSnapshot | null | undefined) ?? null;

	// "Publishing..." while the pointer catches up with a version that passed
	// its checks. Re-rendered once a second while it is on, so it goes when the
	// bounded wait ends even though the poll that would re-render it has
	// stopped by then.
	const awaitingPublish = awaitsPublishAt(Date.now());
	const commitSyncing = instructionsAwaitsCommitSync({
		awaited: awaitedCommit,
		publishedSha: publishedRowRef.current?.sourceCommitSha,
		configuredRef: syncState?.configured?.ref,
		now: Date.now(),
	});
	const [, setClock] = useState(0);
	useEffect(() => {
		if (!awaitingPublish && !commitSyncing) {
			return;
		}
		const timer = setInterval(() => setClock((n) => n + 1), 1000);
		return () => clearInterval(timer);
	}, [awaitingPublish, commitSyncing]);
	// Done waiting, whether Fabric's copy took the commit, the wait ran out or
	// the sync moved to another branch: the status block then says what is
	// true (current, or behind), no error.
	useEffect(() => {
		if (awaitedCommit !== null && !commitSyncing) {
			setAwaitedCommit(null);
		}
	}, [awaitedCommit, commitSyncing]);

	// The two queries are polled separately, so when a deferred scan's verdict
	// lands (Fizzy #2737) one of them can hold it a tick before the other. The
	// published view renders its alert off the POINTER row and History off the
	// list, so a disagreement between the two about the same version is
	// re-read at once rather than left on screen until the next tick.
	const publishedRow = publishedRowRef.current;
	const listedPublished = publishedRow
		? snapshotsRef.current?.find((s) => s.id === publishedRow.id)
		: undefined;
	const deferredScanDisagrees =
		publishedRow !== null &&
		listedPublished !== undefined &&
		(listedPublished.deferredScanStatus ?? null) !==
			(publishedRow.deferredScanStatus ?? null);
	useEffect(() => {
		if (!deferredScanDisagrees) {
			return;
		}
		queryClient.invalidateQueries({
			queryKey: orpc.projects.instructions.getPublished.queryOptions({
				input: { projectId },
			}).queryKey,
		});
		queryClient.invalidateQueries({
			queryKey: orpc.projects.instructions.list.queryOptions({
				input: { projectId },
			}).queryKey,
		});
	}, [deferredScanDisagrees, projectId, queryClient]);

	const newest = snapshotsRef.current?.[0];
	const newestId = newest?.id;
	const newestStatus = newest?.status;
	useEffect(() => {
		// Runs once per change of the newest snapshot's id or status, so the
		// invalidation below happens once per snapshot that reaches READY —
		// never on a steady-state visit to a tab whose pointer is already
		// correct, and never twice for the same one.
		if (
			newestStatus !== "READY" ||
			!newestId ||
			publishedIdRef.current === newestId
		) {
			setReadySeen(null);
			return;
		}
		// First sighting of this snapshot as READY: start the convergence
		// budget, and ask for the pointer NOW rather than at the next tick —
		// the publish activity usually lands within a second of the READY
		// write, and a poll interval of staleness is the whole complaint.
		setReadySeen({ snapshotId: newestId, at: Date.now() });
		queryClient.invalidateQueries({
			queryKey: orpc.projects.instructions.getPublished.queryOptions({
				input: { projectId },
			}).queryKey,
		});
		// A proposal's scan status changes on the same snapshot workflow as a
		// direct upload. Refresh the editor inbox with that poll so a ready diff
		// appears without a reload, while readers never mount the privileged
		// query in the first place.
		queryClient.invalidateQueries({
			queryKey: orpc.projects.instructions.proposals.list.queryOptions({
				input: { projectId },
			}).queryKey,
		});
	}, [newestId, newestStatus, projectId, queryClient]);

	useEffect(() => {
		// A run closed, or a new latest run appeared between two idle reads:
		// a run the scheduled check or a push started and finished unseen, or
		// a failure the check recorded. Whatever it produced (a new version, a
		// rejected one, or nothing) is readable now, so read it rather than
		// wait on a poll that is off or a minute away.
		if (
			syncRunEnded(wasSyncRunningRef.current, syncRunning) ||
			latestSyncRunChanged(lastSyncRunIdRef.current, latestSyncRunId)
		) {
			queryClient.invalidateQueries({
				queryKey: orpc.projects.instructions.list.queryOptions({
					input: { projectId },
				}).queryKey,
			});
			queryClient.invalidateQueries({
				queryKey: orpc.projects.instructions.getPublished.queryOptions({
					input: { projectId },
				}).queryKey,
			});
			queryClient.invalidateQueries({
				queryKey:
					orpc.projects.instructions.repositorySync.listRuns.queryOptions(
						{
							input: { projectId },
						},
					).queryKey,
			});
		}
		wasSyncRunningRef.current = syncRunning;
		if (latestSyncRunId !== undefined) {
			lastSyncRunIdRef.current = latestSyncRunId;
		}
	}, [syncRunning, latestSyncRunId, projectId, queryClient]);

	// Resolves once the three re-reads settle. The upload dialog and the
	// published view ignore the promise; `onChanged` below waits for it.
	const invalidate = () =>
		Promise.all([
			queryClient.invalidateQueries({
				queryKey: orpc.projects.instructions.list.queryOptions({
					input: { projectId },
				}).queryKey,
			}),
			queryClient.invalidateQueries({
				queryKey: orpc.projects.instructions.getPublished.queryOptions({
					input: { projectId },
				}).queryKey,
			}),
			queryClient.invalidateQueries({
				queryKey:
					orpc.projects.instructions.proposals.list.queryOptions({
						input: { projectId },
					}).queryKey,
			}),
		]);

	// Resolves only once every re-read has settled, so the settings section
	// stays busy until the new state is on screen (Decision 53).
	const rereadSync = async () => {
		await Promise.all([
			queryClient.invalidateQueries({
				queryKey:
					orpc.projects.instructions.repository.getState.queryOptions(
						{ input: { projectId } },
					).queryKey,
			}),
			queryClient.invalidateQueries({
				queryKey: syncQuery.queryKey,
			}),
			// The mode flips with a configuration change, and
			// `repositoryBacked` is read from the settings.
			queryClient.invalidateQueries({
				queryKey: orpc.projects.instructions.getSettings.queryOptions({
					input: { projectId },
				}).queryKey,
			}),
			// History marks each run as from the current configuration or an
			// earlier one, judged against the row a change just replaced or
			// removed; re-read it with the state, not a minute later (Fizzy
			// #2694).
			queryClient.invalidateQueries({
				queryKey:
					orpc.projects.instructions.repositorySync.listRuns.queryOptions(
						{
							input: { projectId },
						},
					).queryKey,
			}),
			// A move into a repository starts, is canceled or finishes with a
			// change here, and the move's own read follows it (Fizzy #2878 §9).
			queryClient.invalidateQueries({
				queryKey:
					orpc.projects.instructions.repositorySync.getMigration.queryOptions(
						{
							input: { projectId },
						},
					).queryKey,
			}),
			invalidate(),
		]);
	};
	// The move of uploaded instructions into a repository: read only while the
	// sync state says one is open, and re-read everything once it is gone.
	const migration = useRepositoryMigration({
		projectId,
		enabled: Boolean(syncState?.migration),
		onGone: () => void rereadSync(),
	});

	const syncControls: RepositorySyncControls | undefined = syncState
		? {
				state: syncState,
				onConfigure: () => setConfigureOpen(true),
				onMove: () => setMoveOpen(true),
				onSyncNow: () => syncNow.mutate({ projectId }),
				syncNowPending: syncNow.isPending,
				onChanged: rereadSync,
				migration: {
					read: migration.read,
					endedNotice: migration.endedNotice,
					onDismissEndedNotice: migration.dismissEndedNotice,
				},
			}
		: undefined;

	// The empty state's Connect dialog needs the same route the published
	// view computes for itself (`localSetupRouteFor`, Fizzy #2721):
	// `repositoryBacked` fails closed until the setting has LOADED
	// (`isSuccess`, not `!isLoading` — a failed settings request also stops
	// loading, and the CLI would then be offered for a project it refuses);
	// `repositoryConfirmed` follows only a RESOLVED setting.
	const settingsNameRepository =
		settings.isSuccess && settings.data.sourceOfTruth === "REPOSITORY";
	const localSetup = localSetupRouteFor({
		repositoryBacked: !settings.isSuccess || settingsNameRepository,
		repositoryConfirmed: settingsNameRepository,
		configured: syncState?.configured ?? null,
	});

	if (published.isLoading || latest.isLoading) {
		return <InstructionsTabSkeleton />;
	}
	const snapshots = latest.data ?? [];
	// A failed read is not an empty project. `latest` failing leaves no list at
	// all; `published` failing with an empty list leaves neither a pointer nor
	// a version to show. Either would fall through to the empty state below,
	// which invites an upload over a published version nobody could see. (A
	// failed pointer with a list to show is handled by the view:
	// `publishedUnknown`.)
	if (
		latest.isError ||
		(published.isError && !published.data && snapshots.length === 0)
	) {
		return (
			<InstructionsLoadError
				retrying={published.isFetching || latest.isFetching}
				onRetry={() => {
					if (published.isError) {
						void published.refetch();
					}
					if (latest.isError) {
						void latest.refetch();
					}
				}}
			/>
		);
	}
	const dialog = (
		<UploadFolderDialog
			projectId={projectId}
			open={uploadOpen}
			onOpenChange={setUploadOpen}
			onUploaded={invalidate}
			onDiscarded={invalidate}
			projectGlobs={settings.data?.ignoreGlobs ?? null}
			settingsReady={!settings.isLoading}
			// Publishing before the scan (Fizzy #2737) needs the publish
			// permission as well as the upload one; `begin` re-checks both.
			canPublishBeforeScan={canEdit && canReview}
		/>
	);
	const configureDialog =
		configureOpen && syncState?.canConfigure ? (
			<ConfigureRepositorySyncDialog
				projectId={projectId}
				open
				onOpenChange={setConfigureOpen}
				integrations={syncState.availableIntegrations}
				current={syncState.configured}
				onSaved={() => syncControls?.onChanged()}
			/>
		) : null;

	const moveDialog =
		moveOpen && syncState && offersMoveIntoRepository(syncState) ? (
			<MoveInstructionsDialog
				projectId={projectId}
				open
				onOpenChange={setMoveOpen}
				integrations={syncState.availableIntegrations}
				onStarted={() => void rereadSync()}
			/>
		) : null;

	// A failed settings read holds Upload and the edit actions back (the source
	// of truth is in the settings); say so, with a way to try again, rather than
	// letting the buttons vanish.
	const settingsNotice = settings.isError ? (
		<InstructionsSettingsNotice
			retrying={settings.isFetching}
			onRetry={() => void settings.refetch()}
		/>
	) : null;

	if (!published.data && snapshots.length === 0) {
		return (
			<InstructionMigrationRepositoryProvider
				repository={migrationRepository}
			>
				{dialog}
				{configureDialog}
				{moveDialog}
				<InstructionsEmptyState
					projectId={projectId}
					projectName={projectName}
					notice={settingsNotice}
					onUploadClick={() => setUploadOpen(true)}
					canUpload={
						canEdit &&
						settings.isSuccess &&
						settings.data.sourceOfTruth !== "REPOSITORY"
					}
					// `localSetupRouteFor` above, shared with the published
					// view (Fizzy #2721).
					localSetup={localSetup}
					repositorySync={syncControls}
				/>
			</InstructionMigrationRepositoryProvider>
		);
	}
	// `getPublished`/`list` return the raw Prisma row shape, whose `rejection`
	// and `settingsFrozen` columns are generic Json — narrowed here, once, to
	// the shape `InstructionsPublishedView` actually consumes (see that
	// module's doc comment).
	return (
		<InstructionMigrationRepositoryProvider
			repository={migrationRepository}
		>
			{dialog}
			{configureDialog}
			{moveDialog}
			<InstructionsPublishedView
				projectId={projectId}
				projectName={projectName}
				notice={settingsNotice}
				published={
					(published.data as unknown as
						| InstructionsSnapshot
						| undefined) ?? null
				}
				snapshots={snapshots as unknown as InstructionsSnapshot[]}
				onReplaceClick={() => setUploadOpen(true)}
				onChanged={invalidate}
				canEdit={canEdit}
				canReview={canReview}
				// INSTRUCTION_READ, answered by the read-gated sync state
				// loading at all: the project row carries CREATE and UPDATE
				// flags only. A reader may suggest a change on a
				// repository-backed project once the project allows it
				// (Fizzy #2563 spec §12); until the state loads, or if it
				// fails, the view offers them nothing.
				canRead={repositorySync.isSuccess}
				// A FAILED pointer query, not an empty one. Both leave
				// `published` null, and History has to distinguish them: with
				// no pointer it cannot tell a publish from a rollback, so it
				// says so rather than labelling every version a publish.
				publishedUnknown={published.isError}
				awaitingPublish={awaitingPublish}
				readOnlyMode={readOnlyMode}
				// A commit made from this tab: read the published state until it
				// has taken it, and say so in the status block meanwhile.
				onCommitted={(commit) => {
					setAwaitedCommit({ ...commit, at: Date.now() });
					queryClient.invalidateQueries({
						queryKey: syncQuery.queryKey,
					});
				}}
				syncingCommit={
					commitSyncing && awaitedCommit
						? { sha: awaitedCommit.sha, ref: awaitedCommit.ref }
						: null
				}
				// Spec §6.12: a repository-backed project's instructions are
				// changed in git and refreshed by sync, so the tab does not
				// offer to edit them. Treated as repository-backed until the
				// setting has loaded, so the actions cannot appear and then
				// vanish — and the server refuses either way.
				repositoryBacked={
					!settings.isSuccess ||
					settings.data.sourceOfTruth === "REPOSITORY"
				}
				// Copy, unlike the actions above, follows only a RESOLVED
				// setting: a loading or failed settings request must not tell
				// someone their files now live in the repository.
				repositoryConfirmed={
					settings.isSuccess &&
					settings.data.sourceOfTruth === "REPOSITORY"
				}
				repositorySync={syncControls}
			/>
		</InstructionMigrationRepositoryProvider>
	);
}
