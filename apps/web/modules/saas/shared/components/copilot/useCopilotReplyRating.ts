"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { CopilotReplyVote } from "./CopilotReplyRatingContext";

const SUBJECT_TYPE = "copilot-message";
const NO_MESSAGE_IDS: string[] = [];
const NO_BATCHES: string[][] = [];
type Reply = { id: string; content?: unknown };
type RatingList = { outcomes: Record<string, string> };

export function useCopilotReplyRating({
	featureKey,
	projectId,
	enabled,
}: {
	featureKey: string;
	projectId: string;
	enabled: boolean;
}) {
	const t = useTranslations("tooltips.copilot");
	const queryClient = useQueryClient();
	const scope = JSON.stringify([featureKey, projectId]);
	const [registered, setRegistered] = useState<{
		scope: string;
		ids: string[];
		batches: string[][];
	}>({ scope, ids: [], batches: [] });
	const messageIds =
		registered.scope === scope ? registered.ids : NO_MESSAGE_IDS;
	const setMessageIds = useCallback(
		(ids: string[]) => {
			const distinct = [...new Set(ids)];
			setRegistered((previous) => {
				if (
					previous.scope === scope &&
					JSON.stringify(previous.ids) === JSON.stringify(distinct)
				) {
					return previous;
				}
				// Preserve existing batch keys as replies arrive or move into history.
				const batches =
					previous.scope === scope ? previous.batches : [];
				const known = new Set(batches.flat());
				const added = distinct.filter((id) => !known.has(id));
				const nextBatches = [...batches];
				for (let i = 0; i < added.length; i += 200) {
					nextBatches.push(added.slice(i, i + 200));
				}
				return { scope, ids: distinct, batches: nextBatches };
			});
		},
		[scope],
	);
	const batches =
		registered.scope === scope ? registered.batches : NO_BATCHES;
	const queries = useQueries({
		queries: (enabled ? batches : NO_BATCHES).map((subjectIds) => ({
			...orpc.ai.feedback.list.queryOptions({
				input: {
					featureKey,
					subjectType: SUBJECT_TYPE,
					subjectIds,
					projectId,
				},
			}),
			queryKey: ["copilot-reply-ratings", scope, subjectIds],
			// Votes change through this hook, which updates the cached outcomes.
			staleTime: Number.POSITIVE_INFINITY,
		})),
	});
	const savedVotes = Object.assign(
		{},
		...queries.map((query) => query.data?.outcomes),
	) as Record<string, string>;
	const batchForMessage = useMemo(() => {
		const result = new Map<string, number>();
		batches.forEach((ids, index) => {
			for (const id of ids) {
				result.set(id, index);
			}
		});
		return result;
	}, [batches]);
	const renderedIds = useMemo(() => new Set(messageIds), [messageIds]);
	const canRate = (id: string) => {
		const index = batchForMessage.get(id);
		// TanStack retains data when a background refetch fails.
		return (
			enabled &&
			renderedIds.has(id) &&
			index !== undefined &&
			queries[index]?.data !== undefined
		);
	};
	// Keep local decisions above list responses, including requests begun before a click.
	const [localVotes, setLocalVotes] = useState<
		Record<string, Record<string, CopilotReplyVote | null>>
	>({});
	const inFlight = useRef(new Set<string>());
	const [pending, setPending] = useState(new Set<string>());
	const getVote = (id: string): CopilotReplyVote | undefined => {
		const value = Object.hasOwn(localVotes[scope] ?? {}, id)
			? localVotes[scope][id]
			: savedVotes[id];
		return value === "RATED_UP" || value === "RATED_DOWN"
			? value
			: undefined;
	};
	const mutation = useMutation({
		mutationFn: async ({
			id,
			vote,
		}: {
			id: string;
			vote: CopilotReplyVote | null;
		}) => {
			const subject = {
				featureKey,
				subjectType: SUBJECT_TYPE,
				subjectId: id,
				projectId,
			};
			if (vote === null) {
				await orpcClient.ai.feedback.clear(subject);
			} else {
				await orpcClient.ai.feedback.rate({
					...subject,
					outcome: vote,
				});
			}
		},
	});
	const toggle = async (message: Reply, requested: CopilotReplyVote) => {
		const id = message.id;
		const lock = JSON.stringify([scope, id]);
		if (
			!canRate(id) ||
			typeof message.content !== "string" ||
			!message.content.trim() ||
			inFlight.current.has(lock)
		) {
			return;
		}
		inFlight.current.add(lock);
		setPending(new Set(inFlight.current));
		const previous = getVote(id) ?? null;
		const next = previous === requested ? null : requested;
		const applyLocal = (vote: CopilotReplyVote | null) =>
			setLocalVotes((current) => ({
				...current,
				[scope]: { ...current[scope], [id]: vote },
			}));
		applyLocal(next);
		try {
			await mutation.mutateAsync({ id, vote: next });
			queryClient.setQueriesData<RatingList>(
				{ queryKey: ["copilot-reply-ratings", scope] },
				(data) => {
					if (!data) {
						return data;
					}
					const outcomes = { ...data.outcomes };
					if (next === null) {
						delete outcomes[id];
					} else {
						outcomes[id] = next;
					}
					return { outcomes };
				},
			);
		} catch {
			applyLocal(previous);
			toast.error(t("replyRatingError"));
		} finally {
			inFlight.current.delete(lock);
			setPending(new Set(inFlight.current));
		}
	};
	const latest = useRef({ toggle, getVote, canRate });
	latest.current = { toggle, getVote, canRate };
	const callbacks = useMemo(
		() => ({
			onThumbsUp: (message: Reply) =>
				latest.current.toggle(message, "RATED_UP"),
			onThumbsDown: (message: Reply) =>
				latest.current.toggle(message, "RATED_DOWN"),
			getVote: (id: string) => latest.current.getVote(id),
			canRate: (id: string) => latest.current.canRate(id),
		}),
		[latest],
	);
	const ratingInputs = JSON.stringify([
		scope,
		enabled,
		messageIds,
		savedVotes,
		localVotes,
		queries.map((query) => query.data !== undefined),
	]);
	return useMemo(
		() => ({
			...callbacks,
			setMessageIds,
			isPending: (id: string) => pending.has(JSON.stringify([scope, id])),
		}),
		[callbacks, setMessageIds, pending, scope, ratingInputs],
	);
}
