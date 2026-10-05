"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
	type MigrationEndedNotice,
	migrationEndedNotice,
	migrationPollInterval,
	type RepositoryMigrationRead,
	type RepositoryMigrationView,
} from "../lib/instructions-migration";

/**
 * The tab's read of a move of uploaded instructions into a repository (Fizzy
 * #2878 §9). It asks only while the sync state says a move is open
 * (`enabled`), at the pace `migrationPollInterval` sets, and says so through
 * `onGone` once the move is gone, whether it completed, was canceled or ended
 * with its pull request closed, so the tab re-reads everything the move
 * changed. A move that ended without its files landing also leaves a notice,
 * kept until it is dismissed: the move is gone from the server by then, and
 * the notice is the only place that says why the instructions did not move.
 */
export function useRepositoryMigration({
	projectId,
	enabled,
	onGone,
}: {
	projectId: string;
	enabled: boolean;
	onGone: () => void;
}): {
	read: RepositoryMigrationRead | undefined;
	endedNotice: MigrationEndedNotice | null;
	dismissEndedNotice: () => void;
} {
	const query = useQuery({
		...orpc.projects.instructions.repositorySync.getMigration.queryOptions({
			input: { projectId },
		}),
		enabled,
		refetchInterval: (q) =>
			migrationPollInterval(
				q.state.data as RepositoryMigrationRead | undefined,
			),
	});
	const read = enabled
		? (query.data as RepositoryMigrationRead | undefined)
		: undefined;
	// `undefined`: not read yet, so nothing can be said about it. A move whose
	// pointer the sync state has already cleared is gone, whatever was cached.
	const current: RepositoryMigrationView | null | undefined = enabled
		? read?.migration
		: null;
	const lastSeen = useRef<RepositoryMigrationView | null>(null);
	// The repository is named by the read, which is gone with the move: a
	// notice about a move that ended has to remember it.
	const lastRepository = useRef<string | null>(null);
	const [endedNotice, setEndedNotice] = useState<MigrationEndedNotice | null>(
		null,
	);
	const onGoneRef = useRef(onGone);
	onGoneRef.current = onGone;
	const repository = read?.repository
		? `${read.repository.owner}/${read.repository.name}`
		: null;
	useEffect(() => {
		if (current === undefined) {
			return;
		}
		const notice = migrationEndedNotice(
			lastSeen.current,
			current,
			lastRepository.current,
		);
		if (notice) {
			setEndedNotice(notice);
		}
		if (current === null && lastSeen.current !== null) {
			onGoneRef.current();
		}
		lastSeen.current = current;
		lastRepository.current = repository ?? lastRepository.current;
	}, [current, repository]);
	return {
		read,
		endedNotice,
		dismissEndedNotice: () => setEndedNotice(null),
	};
}
