"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	instructionsAwaitsPublish,
	instructionsPollInterval,
} from "../../lib/instructions-poll";
import {
	latestSyncRunChanged,
	localSetupRouteFor,
	REPOSITORY_SYNC_POLL_MS,
	type RepositorySyncControls,
	type RepositorySyncState,
	repositorySyncPollInterval,
	type SyncNowResult,
	syncNowResultMessage,
	syncRunEnded,
} from "../../lib/instructions-repository-sync";
import { ConfigureRepositorySyncDialog } from "./ConfigureRepositorySyncDialog";
import { InstructionsEmptyState } from "./InstructionsEmptyState";
import {
	InstructionsPublishedView,
	type InstructionsSnapshot,
} from "./InstructionsPublishedView";
import { UploadFolderDialog } from "./UploadFolderDialog";

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
};

export function CodingInstructionsTab({
	projectId,
	projectName,
	canEdit = false,
	canReview = false,
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
}) {
	const queryClient = useQueryClient();
	const [uploadOpen, setUploadOpen] = useState(false);
	const [configureOpen, setConfigureOpen] = useState(false);
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
			awaitingPublish: instructionsAwaitsPublish({
				snapshots,
				publishedId: publishedIdRef.current,
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
	const syncRunning = syncState?.running ?? false;
	syncRunningRef.current = syncRunning;
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
			onError: (error) => toast.error(error.message),
		}),
	);

	snapshotsRef.current = latest.data as PollSnapshot[] | undefined;
	publishedIdRef.current =
		(published.data as { id?: string } | null | undefined)?.id ?? null;
	publishedRowRef.current =
		(published.data as PollSnapshot | null | undefined) ?? null;

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

	const syncControls: RepositorySyncControls | undefined = syncState
		? {
				state: syncState,
				onConfigure: () => setConfigureOpen(true),
				onSyncNow: () => syncNow.mutate({ projectId }),
				syncNowPending: syncNow.isPending,
				// Resolves only once every re-read has settled, so the
				// settings section stays busy until the new state is on
				// screen (Decision 53).
				onChanged: async () => {
					await Promise.all([
						queryClient.invalidateQueries({
							queryKey: syncQuery.queryKey,
						}),
						// The mode flips with a configuration change, and
						// `repositoryBacked` is read from the settings.
						queryClient.invalidateQueries({
							queryKey:
								orpc.projects.instructions.getSettings.queryOptions(
									{
										input: { projectId },
									},
								).queryKey,
						}),
						// History marks each run as from the current
						// configuration or an earlier one, judged against the
						// row a change just replaced or removed; re-read it
						// with the state, not a minute later (Fizzy #2694).
						queryClient.invalidateQueries({
							queryKey:
								orpc.projects.instructions.repositorySync.listRuns.queryOptions(
									{
										input: { projectId },
									},
								).queryKey,
						}),
						invalidate(),
					]);
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
		return null;
	}
	const snapshots = latest.data ?? [];
	const dialog = (
		<UploadFolderDialog
			projectId={projectId}
			open={uploadOpen}
			onOpenChange={setUploadOpen}
			onUploaded={invalidate}
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

	if (!published.data && snapshots.length === 0) {
		return (
			<>
				{dialog}
				{configureDialog}
				<InstructionsEmptyState
					projectId={projectId}
					projectName={projectName}
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
			</>
		);
	}
	// `getPublished`/`list` return the raw Prisma row shape, whose `rejection`
	// and `settingsFrozen` columns are generic Json — narrowed here, once, to
	// the shape `InstructionsPublishedView` actually consumes (see that
	// module's doc comment).
	return (
		<>
			{dialog}
			{configureDialog}
			<InstructionsPublishedView
				projectId={projectId}
				projectName={projectName}
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
		</>
	);
}
