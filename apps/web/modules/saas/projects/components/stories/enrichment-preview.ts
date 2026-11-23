/**
 * The structure-preserving merge of a re-routed item into the ticket the
 * reviewer chose, read at review time. The item's change summary, its
 * line-by-line review and its apply all use this one merge, so what the
 * reviewer sees is what is written.
 *
 * The routing control and the proposal view read it through the same query
 * options, so one request serves both.
 */

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQueries } from "@tanstack/react-query";
import type { ChangeItem } from "./BacklogChangeProposal";
import type { RoutingAnnotation } from "./ProposalRoutingControl";

/** What `previewEnrichment` answers: the target now, and the merge. */
export type EnrichmentPreview = {
	targetId: string;
	targetIdentifier: string;
	targetTitle: string;
	targetClosed: boolean;
	currentDescription: string;
	currentAcceptanceCriteria: string;
	currentPriority: string;
	currentSize: string | null;
	mergedDescription: string;
	mergedAcceptanceCriteria: string;
	/** No safe targeted edit: the target's body would be kept as it is. */
	fallbackUsed: boolean;
};

/** The merge of one re-routed item, as the proposal view tracks it. */
export type EnrichmentPreviewState =
	| { status: "loading" }
	| { status: "ready"; preview: EnrichmentPreview }
	| { status: "error"; retry: () => void };

export function enrichmentPreviewQueryOptions(params: {
	projectId: string | undefined;
	organizationId: string | null | undefined;
	targetStoryId: string | undefined;
	routing: Pick<
		RoutingAnnotation,
		"proposedDescription" | "proposedAcceptanceCriteria" | "reasoning"
	>;
}) {
	return {
		...orpc.projects.stories.previewEnrichment.queryOptions({
			input: {
				projectId: params.projectId ?? "",
				organizationId: params.organizationId ?? null,
				targetStoryId: params.targetStoryId ?? "",
				proposedDescription:
					params.routing.proposedDescription ?? undefined,
				proposedAcceptanceCriteria:
					params.routing.proposedAcceptanceCriteria ?? undefined,
				reasoning: params.routing.reasoning ?? undefined,
			},
		}),
		enabled: !!params.targetStoryId && !!params.projectId,
		staleTime: 60_000,
	};
}

/** The merge state of every re-routed item, by index. */
export function useEnrichmentPreviews(params: {
	projectId: string | undefined;
	organizationId: string | null | undefined;
	/** Each re-routed item and the ticket it now targets. */
	rerouted: ReadonlyArray<{
		index: number;
		targetStoryId: string;
		routing: RoutingAnnotation;
	}>;
}): ReadonlyMap<number, EnrichmentPreviewState> {
	const results = useQueries({
		queries: params.rerouted.map((item) =>
			enrichmentPreviewQueryOptions({
				projectId: params.projectId,
				organizationId: params.organizationId,
				targetStoryId: item.targetStoryId,
				routing: item.routing,
			}),
		),
	});
	return new Map(
		params.rerouted.map((item, position) => {
			const result = results[position];
			const state: EnrichmentPreviewState = result?.data
				? { status: "ready", preview: result.data }
				: result?.isError
					? {
							status: "error",
							retry: () => {
								void result.refetch();
							},
						}
					: { status: "loading" };
			return [item.index, state];
		}),
	);
}

/**
 * The update a re-routed item applies, with the merge in place of the
 * captured text: its `from` sides are the target as the merge read it, and
 * `structurePreserved` tells the apply not to merge again (it still merges
 * into the current text when the ticket changes before then). Its priority
 * and size are set against the target's, so a value the target already has
 * is neither listed nor written. When no safe merge exists the body is left
 * out, as the preview says it is kept.
 */
export function withEnrichmentPreview(
	change: ChangeItem,
	preview: EnrichmentPreview,
): ChangeItem {
	const title = { from: preview.targetTitle, to: preview.targetTitle };
	const priority = againstTarget(change.priority, preview.currentPriority);
	const size = againstTarget(change.size, preview.currentSize);
	if (preview.fallbackUsed) {
		return {
			...change,
			title,
			priority,
			size,
			description: undefined,
			acceptanceCriteria: undefined,
			structurePreserved: undefined,
		};
	}
	return {
		...change,
		title,
		priority,
		size,
		description: {
			from: preview.currentDescription,
			to: preview.mergedDescription,
		},
		acceptanceCriteria: {
			from: preview.currentAcceptanceCriteria,
			to: preview.mergedAcceptanceCriteria,
		},
		structurePreserved: true,
	};
}

function againstTarget(
	value: ChangeItem["priority"],
	current: string | null,
): ChangeItem["priority"] {
	return value?.to ? { from: current ?? undefined, to: value.to } : value;
}

/**
 * The merge leaves the target's description and acceptance criteria as they
 * are: no safe merge exists, or it added nothing from the item.
 */
export function mergeKeepsTargetBody(preview: EnrichmentPreview): boolean {
	return (
		preview.fallbackUsed ||
		(preview.mergedDescription === preview.currentDescription &&
			preview.mergedAcceptanceCriteria ===
				preview.currentAcceptanceCriteria)
	);
}
