"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
	type FollowedRuns,
	followRun,
	suggestionPollInterval,
} from "../lib/suggestion-model";

/** A short state the "To confirm" header shows beside its button. */
export type SuggestionRunNotice =
	| "alreadyChecking"
	| "unavailable"
	| "failed"
	| "nothingNew";

/** How long "Nothing new to confirm" stays before the section settles. */
const NOTHING_NEW_VISIBLE_MS = 5_000;

const NOT_FOLLOWING: FollowedRuns = { loudRunId: null, quietRunId: null };

/**
 * "Check my activity": start a generation run for the default range, follow
 * it until it ends, then reload the list.
 *
 * Once enabled, the page also asks the server once for an automatic refresh:
 * on time and materials projects, when the member has had no run for a
 * while. That run, and any run the page did not start itself (one after a
 * meeting, or one begun before a reload), is followed quietly: no spinner,
 * no notice, and its rows appear when it ends. Pressing the button while one
 * runs answers "Already checking" and follows it out loud from then on.
 */
export function useSuggestionRun(params: {
	organizationId: string;
	timeZone: string;
	enabled: boolean;
}) {
	const queryClient = useQueryClient();
	const [followed, setFollowed] = useState<FollowedRuns>(NOT_FOLLOWING);
	const [notice, setNotice] = useState<SuggestionRunNotice | null>(null);
	const refreshRequested = useRef(false);

	const statusQuery = useQuery({
		...orpc.timeTracking.suggestionStatus.queryOptions({
			input: { organizationId: params.organizationId },
		}),
		enabled: params.enabled,
		refetchInterval: (query) =>
			query.state.error
				? false
				: suggestionPollInterval(query.state.data),
	});
	const run = statusQuery.data;

	useEffect(() => {
		const step = followRun(followed, run);
		if (step.followed !== followed) {
			setFollowed(step.followed);
		}
		if (!step.ended) {
			return;
		}
		switch (step.ended) {
			case "failed":
				setNotice("failed");
				break;
			case "empty":
				setNotice("nothingNew");
				break;
			case "found":
				setNotice(null);
				break;
			case "quiet":
				break;
			default: {
				const unhandled: never = step.ended;
				throw new Error(`Unhandled run end: ${String(unhandled)}`);
			}
		}
		void queryClient.invalidateQueries({
			queryKey: orpc.timeTracking.listSuggestions.key(),
		});
	}, [run, followed, queryClient]);

	useEffect(() => {
		if (notice !== "nothingNew") {
			return;
		}
		const timer = setTimeout(() => setNotice(null), NOTHING_NEW_VISIBLE_MS);
		return () => clearTimeout(timer);
	}, [notice]);

	const generate = useMutation({
		mutationFn: () =>
			orpc.timeTracking.generateSuggestions.call({
				organizationId: params.organizationId,
				timezone: params.timeZone,
			}),
		onSuccess: async (result) => {
			if (result.started) {
				setNotice(null);
				setFollowed((current) => ({
					...current,
					loudRunId: result.runId,
				}));
				await queryClient.invalidateQueries({
					queryKey: orpc.timeTracking.suggestionStatus.key(),
				});
				return;
			}
			switch (result.reason) {
				case "in-progress": {
					setNotice("alreadyChecking");
					// The running one may be quiet so far; it is now what the
					// member waits on.
					const { data } = await statusQuery.refetch();
					if (data?.status === "GENERATING") {
						setFollowed({
							loudRunId: data.runId,
							quietRunId: null,
						});
					}
					return;
				}
				case "unavailable":
					setNotice("unavailable");
					return;
				// Only an automatic refresh answers these.
				case "fresh":
				case "no-projects":
					return;
				default: {
					const unhandled: never = result.reason;
					throw new Error(
						`Unhandled generate reason: ${String(unhandled)}`,
					);
				}
			}
		},
		onError: () => setNotice("failed"),
	});

	// Silent whatever it answers: a started run is picked up by the status
	// poll and followed quietly.
	const refresh = useMutation({
		mutationFn: () =>
			orpc.timeTracking.generateSuggestions.call({
				organizationId: params.organizationId,
				timezone: params.timeZone,
				mode: "automatic",
			}),
		onSuccess: async (result) => {
			if (!result.started) {
				return;
			}
			setFollowed((current) =>
				current.loudRunId === null
					? { ...current, quietRunId: result.runId }
					: current,
			);
			await queryClient.invalidateQueries({
				queryKey: orpc.timeTracking.suggestionStatus.key(),
			});
		},
	});
	const requestRefresh = refresh.mutate;

	useEffect(() => {
		if (!params.enabled || refreshRequested.current) {
			return;
		}
		refreshRequested.current = true;
		requestRefresh();
	}, [params.enabled, requestRefresh]);

	const checking = generate.isPending || followed.loudRunId !== null;

	// "Already checking" belongs to a running check; every other state to
	// the time after one.
	const shownNotice =
		checking === (notice === "alreadyChecking") ? notice : null;

	return {
		checking,
		notice: shownNotice,
		check: () => {
			setNotice(null);
			generate.mutate();
		},
	};
}
