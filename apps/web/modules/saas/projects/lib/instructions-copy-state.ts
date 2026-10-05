/**
 * Whether Fabric's published copy of a repository project has followed the
 * branch, as the status block words it. The branch is the authority and
 * Fabric's copy follows it, so the question the block answers is "is what my
 * agents read what the last sync took, and if not why not".
 *
 * Pure, so the tab, the empty state and their tests share one answer. It reads
 * the shape the server reports for a repository project (`repository.sync`:
 * whether automatic sync is on and not paused, and the last run's trigger,
 * status, error, commit and finish time) and the published row's commit, and
 * claims nothing the last run did not say: with no finished run for this
 * configuration the answer is `unknown`, and a block built on it stays quiet
 * rather than guessing.
 *
 * A refused commit is the case it exists for. A commit the secret scan turns
 * away never becomes the published version, so Fabric's copy stays behind the
 * branch's tip while git itself is fine; the developer's session hook says the
 * same thing from its side.
 */

import {
	type RepositorySyncState,
	type SyncMessage,
	syncErrorMessage,
	syncRunOutcome,
} from "./instructions-repository-sync";

export type FabricCopyState =
	| { kind: "unknown" }
	| { kind: "current"; syncedAt: string | Date }
	| { kind: "refused"; commit: string | null; at: string | Date }
	| { kind: "behind-error"; message: SyncMessage };

/** `TREE_REFUSED` is the sync's own word for a tree the secret scan or the tree rules turned away. */
const REFUSED_ERROR = "TREE_REFUSED";

export function fabricCopyState(
	state: RepositorySyncState,
	published: { sourceCommitSha: string | null } | null,
): FabricCopyState {
	const configuration = state.configured;
	if (
		configuration === null ||
		published === null ||
		published.sourceCommitSha === null
	) {
		return { kind: "unknown" };
	}
	// A receipt of a sync that was switched off says nothing about this one,
	// and a run still open has not said anything yet.
	const run = state.latestRun;
	if (
		!run ||
		run.fromCurrentConfiguration === false ||
		run.finishedAt === null ||
		run.status === null
	) {
		return { kind: "unknown" };
	}
	if (run.status === "REJECTED" || run.error === REFUSED_ERROR) {
		return { kind: "refused", commit: run.commitSha, at: run.finishedAt };
	}
	if (run.status === "FAILED") {
		const outcome = syncRunOutcome(run, false);
		const message =
			outcome.kind === "failed"
				? syncErrorMessage(outcome, configuration)
				: null;
		return message
			? { kind: "behind-error", message }
			: { kind: "unknown" };
	}
	if (
		(run.status === "SUCCEEDED" || run.status === "UNCHANGED") &&
		run.commitSha === published.sourceCommitSha
	) {
		return { kind: "current", syncedAt: run.finishedAt };
	}
	return { kind: "unknown" };
}
