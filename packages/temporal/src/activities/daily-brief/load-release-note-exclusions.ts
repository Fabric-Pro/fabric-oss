/**
 * Daily Brief — Release Note Exclusions Loader Activity
 *
 * Reads the project's curated release-note exclusion list (PRs/stories a
 * project member has hidden from the Daily Brief's Release Notes panel).
 * DB-local: no LLM, no external HTTP.
 */

import { db } from "@repo/database";
import { heartbeat } from "@temporalio/activity";
import type { ReleaseNoteExclusion } from "../../workflows/daily-brief-release-note-exclusions";

export interface LoadReleaseNoteExclusionsInput {
	projectId: string;
	organizationId: string | null;
}

export async function loadReleaseNoteExclusionsActivity(
	input: LoadReleaseNoteExclusionsInput,
): Promise<ReleaseNoteExclusion[]> {
	heartbeat("loadReleaseNoteExclusions: starting");

	// Tenant scoping: `projectId` is a globally-unique cuid that pins to
	// exactly one project (hence one owner), and every exclusion row's own
	// `userId` is that owner by construction (set from the verified project at
	// hide time). The `project.organizationId` guard fails closed on any
	// tenant mismatch — an org project passed with `organizationId: null` (or a
	// personal project passed with an org id) matches nothing and returns [].
	// So `projectId` + org already isolate to a single owner's rows without a
	// separate `userId` predicate; this mirrors the sibling `collectAhead`
	// collector's scoping. A personal-context `userId` filter is intentionally
	// omitted here: the only correct value is the project OWNER's id (which
	// `projectId` already pins), NOT the workflow's `triggeredByUserId` — which
	// may differ from the owner on system/scheduled generations and would then
	// wrongly load zero exclusions. See PR #2003 (Codex review adjudication).
	const rows = await db.dailyBriefReleaseNoteExclusion.findMany({
		where: {
			projectId: input.projectId,
			project: { organizationId: input.organizationId },
		},
		select: {
			kind: true,
			repoFullName: true,
			prNumber: true,
			storyIdentifier: true,
		},
	});

	return rows.map((r) => ({
		kind: r.kind as "pr" | "story",
		repoFullName: r.repoFullName,
		prNumber: r.prNumber,
		storyIdentifier: r.storyIdentifier,
	}));
}
