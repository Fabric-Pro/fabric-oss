"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

const BRANCHES_STALE_MS = 5 * 60 * 1000;

/**
 * The branch to show in a repository-sync configure dialog's branch field,
 * in this order of precedence:
 *
 *  1. what the person typed for this repository;
 *  2. the configured sync's `ref`, when the repository is the configured
 *     one — a branch someone chose is never replaced by the provider's;
 *  3. the repository's own default branch, as its provider reports it now
 *     (`repositoryIntegrations.branches`);
 *  4. the integration's stored branch, while the provider has not answered
 *     or when it cannot;
 *  5. empty.
 *
 * Only 3 is new: the stored branch can be stale (a repository connected as
 * `master` whose provider default is now `main`), and seeding a new sync from
 * it fails with "branch not found". The branch names come along as
 * suggestions for the field. Shared by the Coding Instructions and the Living
 * Memory dialogs, which are a paired surface.
 */
export function useRepositoryBranchField({
	projectId,
	open,
	integrationId,
	configuredRef,
	storedBranch,
}: {
	projectId: string;
	open: boolean;
	integrationId: string;
	/** The configured sync's ref when `integrationId` is its repository. */
	configuredRef: string | null;
	/** The integration's stored branch. */
	storedBranch: string | null;
}): {
	ref: string;
	setRef: (next: string) => void;
	/** Forget what was typed, as choosing another repository does. */
	reset: () => void;
	branches: readonly string[];
} {
	const [typed, setTyped] = useState<{
		integrationId: string;
		value: string;
	} | null>(null);
	const query = useQuery(
		orpc.projects.repositoryIntegrations.branches.queryOptions({
			input: { projectId, repositoryIntegrationId: integrationId },
			enabled: open && integrationId !== "",
			staleTime: BRANCHES_STALE_MS,
			retry: false,
		}),
	);
	const typedHere =
		typed && typed.integrationId === integrationId ? typed.value : null;
	const ref =
		typedHere ??
		configuredRef ??
		query.data?.defaultBranch ??
		storedBranch ??
		"";
	return {
		ref,
		setRef: (value) => setTyped({ integrationId, value }),
		reset: () => setTyped(null),
		branches: query.data?.branches ?? [],
	};
}
