"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import {
	duplicateFlagsByIndex,
	NO_DUPLICATE_FLAGS,
	type ProposalDuplicateFlags,
} from "./proposal-duplicate-flags";
import { proposalDuplicateFlagsQueryKey } from "./proposal-inbox-client";

/**
 * How long the inbox's flags are reused before an open checks again. The
 * check embeds the inbox, so it is not repeated on every focus.
 */
const DUPLICATE_FLAGS_STALE_MS = 5 * 60_000;

/**
 * Possible-duplicate flags for the ONE proposal open in the inbox. The flags
 * of the whole inbox come from one project-level query, fetched when a
 * proposal first opens and reused for every other one; never polled. A
 * failed or unavailable check yields no flags: the review goes on as before.
 */
export function useProposalDuplicateFlags(params: {
	projectId: string;
	organizationId: string | null;
	proposalId: string | null;
	enabled: boolean;
}): ProposalDuplicateFlags {
	const { projectId, organizationId, proposalId, enabled } = params;
	const { data } = useQuery({
		queryKey: proposalDuplicateFlagsQueryKey(projectId, organizationId),
		queryFn: async () =>
			await orpcClient.projects.backlog.proposals.duplicateFlags({
				projectId,
				organizationId,
			}),
		enabled: enabled && !!proposalId,
		staleTime: DUPLICATE_FLAGS_STALE_MS,
		refetchOnWindowFocus: false,
		retry: false,
	});
	return useMemo(
		() =>
			data && proposalId
				? duplicateFlagsByIndex(
						data.flags.filter(
							(flag) => flag.proposalId === proposalId,
						),
					)
				: NO_DUPLICATE_FLAGS,
		[data, proposalId],
	);
}
