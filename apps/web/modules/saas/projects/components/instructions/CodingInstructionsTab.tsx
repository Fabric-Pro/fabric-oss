"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
	instructionsAwaitsPublish,
	instructionsPollInterval,
} from "../../lib/instructions-poll";
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
 * nothing to wait for (see `instructions-poll.ts`).
 */
type PollSnapshot = {
	id: string;
	status: string;
	publishOnReady?: boolean;
	createdAt?: string | Date | null;
};

export function CodingInstructionsTab({
	projectId,
	projectName,
	canEdit = false,
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
}) {
	const queryClient = useQueryClient();
	const [uploadOpen, setUploadOpen] = useState(false);
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
		return instructionsPollInterval(snapshots, elapsedMs, {
			now,
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

	snapshotsRef.current = latest.data as PollSnapshot[] | undefined;
	publishedIdRef.current =
		(published.data as { id?: string } | null | undefined)?.id ?? null;

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
	}, [newestId, newestStatus, projectId, queryClient]);

	const invalidate = () => {
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
	};

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
		/>
	);

	if (!published.data && snapshots.length === 0) {
		return (
			<>
				{dialog}
				<InstructionsEmptyState
					projectId={projectId}
					projectName={projectName}
					onUploadClick={() => setUploadOpen(true)}
					// Same gate as the published view: fails closed until the
					// setting has LOADED. `isSuccess`, not `!isLoading` — a
					// failed settings request also stops loading, and the
					// command would then be offered for a project the CLI
					// refuses.
					localSyncAvailable={
						settings.isSuccess &&
						settings.data.sourceOfTruth !== "REPOSITORY"
					}
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
			/>
		</>
	);
}
