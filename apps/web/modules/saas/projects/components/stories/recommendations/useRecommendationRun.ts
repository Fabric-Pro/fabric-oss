"use client";

/**
 * Starts a Roadmap recommendation run and reports how it ended (Fizzy #2208).
 *
 * The run is a background workflow keyed by project, so this hook polls
 * `backlog.recommendationStatus` while one is in flight, and reads it once on
 * mount so a reload still shows a run in progress. An outcome is surfaced only
 * for a run this page started or saw running; a run that finished before the
 * page loaded stays silent.
 *
 * `start` rejects with a `RecommendationStartError` instead of toasting,
 * because its callers already say where the failure happened (the empty
 * state's card, Do both's progress, the Roadmap actions menu). A gate refusal
 * keeps its title apart from its body, so the body reads exactly as approved
 * (FR37) wherever it is shown.
 *
 * Nothing here says proposals exist unless the run reports GENERATED (FR40).
 */

import { ORPCError } from "@orpc/client";
import type { CapabilityGate } from "@repo/api/modules/capabilities/types";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { buildCapabilityGateView } from "../../../lib/capability-gate-view";
import { PROPOSAL_PARAM } from "../../../lib/stories/routes";
import type { RecommendationEntryPoint } from "../roadmap-entry/recommendation-starter";

const POLL_INTERVAL_MS = 2500;

const INSUFFICIENT_CONTEXT_KEY =
	"reason.roadmap.recommend.context-insufficient";

/**
 * Why a run did not start. `message` is the sentence to show; `title` is a
 * refusing gate's headline, shown as its own element, or null.
 */
export class RecommendationStartError extends Error {
	readonly title: string | null;

	constructor(message: string, title: string | null) {
		super(message);
		this.name = "RecommendationStartError";
		this.title = title;
	}
}

/** Toast copy for a start failure: the gate's headline, else `fallbackTitle`. */
export function startErrorToast(
	error: unknown,
	fallbackTitle: string,
	fallbackBody: string,
): { title: string; description: string } {
	return {
		title:
			error instanceof RecommendationStartError && error.title
				? error.title
				: fallbackTitle,
		description: error instanceof Error ? error.message : fallbackBody,
	};
}

interface RecommendationRunArgs {
	projectId: string;
	/** False while the flag is off or no AI provider resolves: no reads at all. */
	enabled: boolean;
}

interface RecommendationRun {
	start(entryPoint: RecommendationEntryPoint): Promise<void>;
	isStarting: boolean;
	isRunning: boolean;
}

export function useRecommendationRun({
	projectId,
	enabled,
}: RecommendationRunArgs): RecommendationRun {
	const t = useTranslations("projects.recommendations");
	const tGates = useTranslations("projects.capabilityGates");
	const queryClient = useQueryClient();
	const router = useRouter();
	const pathname = usePathname();
	const search = useSearchParams().toString();

	// When set, a terminal status read at or after this moment belongs to a run
	// this page is watching. Held in state so the poll interval follows it.
	const [watchingSince, setWatchingSince] = useState<number | null>(null);

	const status = useQuery({
		...orpc.projects.backlog.recommendationStatus.queryOptions({
			input: { projectId },
		}),
		enabled,
		staleTime: 0,
		refetchInterval: (query) =>
			watchingSince !== null || query.state.data?.state === "running"
				? POLL_INTERVAL_MS
				: false,
	});
	const { data, dataUpdatedAt, refetch } = status;

	useEffect(() => {
		if (!data) {
			return;
		}
		if (data.state === "running") {
			if (watchingSince === null) {
				setWatchingSince(dataUpdatedAt);
			}
			return;
		}
		if (
			watchingSince === null ||
			dataUpdatedAt < watchingSince ||
			data.state === "idle"
		) {
			return;
		}
		setWatchingSince(null);

		// A finished run changes what the recommend gate reads, and a batch
		// changes the inbox's list and badge.
		queryClient.invalidateQueries({ queryKey: ["capability-gates"] });
		queryClient.invalidateQueries({
			queryKey: ["teams-channel-monitor-pending-proposals", projectId],
		});
		queryClient.invalidateQueries({
			queryKey: [
				"teams-channel-monitor-pending-proposals-count",
				projectId,
			],
		});

		if (data.state === "failed") {
			toast.error(t("generationFailed"));
			return;
		}
		switch (data.outcome) {
			case "GENERATED": {
				toast.success(t("generated", { count: data.changeCount }), {
					description: t("generatedDescription"),
				});
				if (data.proposalId) {
					const next = new URLSearchParams(search);
					next.set(PROPOSAL_PARAM, data.proposalId);
					router.replace(`${pathname}?${next.toString()}`, {
						scroll: false,
					});
				}
				return;
			}
			case "INSUFFICIENT_CONTEXT":
				toast.warning(tGates(`${INSUFFICIENT_CONTEXT_KEY}.title`), {
					description: tGates(`${INSUFFICIENT_CONTEXT_KEY}.body`),
				});
				return;
			case "NO_RECOMMENDATIONS":
				toast.info(t("noRecommendations"));
				return;
		}
	}, [
		data,
		dataUpdatedAt,
		watchingSince,
		queryClient,
		projectId,
		router,
		pathname,
		search,
		t,
		tGates,
	]);

	// A refusal at the door carries the gate that refused it; say what it
	// said, title and body apart. Anything else gets FR39.
	const startFailure = useCallback(
		(error: unknown): RecommendationStartError => {
			const fallback = new RecommendationStartError(
				t("generationFailed"),
				null,
			);
			if (
				!(error instanceof ORPCError) ||
				error.code !== "PRECONDITION_FAILED"
			) {
				return fallback;
			}
			const gate = (error.data as { gate?: CapabilityGate } | undefined)
				?.gate;
			const view = gate ? buildCapabilityGateView(gate) : null;
			if (view) {
				return new RecommendationStartError(
					tGates(view.body, view.params),
					tGates(view.title),
				);
			}
			return error.message
				? new RecommendationStartError(error.message, null)
				: fallback;
		},
		[t, tGates],
	);

	const startMutation = useMutation({
		mutationFn: (entryPoint: RecommendationEntryPoint) =>
			orpcClient.projects.backlog.generateRecommendations({
				projectId,
				entryPoint,
			}),
	});
	const { mutateAsync } = startMutation;

	const start = useCallback(
		async (entryPoint: RecommendationEntryPoint) => {
			// Taken before the request, so any read that lands after the run
			// started counts, and one that landed before it never does.
			const since = Date.now();
			let result: { alreadyRunning: boolean };
			try {
				result = await mutateAsync(entryPoint);
			} catch (error) {
				throw startFailure(error);
			}
			if (result.alreadyRunning) {
				toast.info(t("alreadyRunning"));
			} else {
				toast.success(t("started"), {
					description: t("startedDescription"),
				});
			}
			setWatchingSince(since);
			void refetch();
		},
		[mutateAsync, refetch, t, startFailure],
	);

	return {
		start,
		isStarting: startMutation.isPending,
		isRunning: watchingSince !== null || data?.state === "running",
	};
}
