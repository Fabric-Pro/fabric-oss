"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import {
	useInfiniteQuery,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { isLiveSession } from "../lib/parlume-format";
import {
	LIVE_ACTIVITY_QUERY_KEY,
	SESSIONS_QUERY_KEY,
	USAGE_QUERY_KEY,
} from "../lib/query-keys";
import { ParlumeActivityPanel } from "./ParlumeActivityPanel";
import { ParlumeHowItWorks } from "./ParlumeHowItWorks";
import { ParlumeInviteCard } from "./ParlumeInviteCard";
import { ParlumeJoiningCard } from "./ParlumeJoiningCard";
import { ParlumeLiveCard } from "./ParlumeLiveCard";
import { ParlumeLockedCard } from "./ParlumeLockedCard";
import { ParlumeSpendCard } from "./ParlumeSpendCard";

const POLL_MS = 10_000;

export function ParlumePage({
	projectId,
	projectBasePath,
	canEdit,
}: {
	projectId: string;
	/** `/app/{org}/projects/{id}`, where a session's transcript lives under `/contexts`. */
	projectBasePath: string;
	canEdit: boolean;
}) {
	const queryClient = useQueryClient();
	const [stoppingSessionId, setStoppingSessionId] = useState<string | null>(
		null,
	);
	const [stopError, setStopError] = useState<string | null>(null);
	const firstPage: { id: string; createdAt: Date } | undefined = undefined;
	const sessionsQuery = useInfiniteQuery({
		queryKey: [SESSIONS_QUERY_KEY, projectId],
		initialPageParam: firstPage,
		queryFn: ({
			pageParam,
		}: {
			pageParam: { id: string; createdAt: Date } | undefined;
		}) =>
			orpcClient.projects.parlume.listSessions({
				projectId,
				before: pageParam,
			}),
		getNextPageParam: (page) => page.nextCursor ?? undefined,
		retry: false,
		refetchInterval: (query) =>
			query.state.data?.pages[0]?.sessions.some(isLiveSession)
				? POLL_MS
				: false,
	});
	const sessions =
		sessionsQuery.data?.pages.flatMap((page) => page.sessions) ?? [];
	// The live session is the newest, so it is always on page 1.
	const liveSession =
		sessionsQuery.data?.pages[0]?.sessions.find(isLiveSession);
	const liveSessionId = liveSession?.id;
	const sessionsTotal = sessionsQuery.data?.pages[0]?.total ?? null;

	const usageQuery = useQuery({
		queryKey: [USAGE_QUERY_KEY, projectId],
		queryFn: () => orpcClient.projects.parlume.usage({ projectId }),
		retry: false,
		refetchInterval: liveSessionId ? POLL_MS : false,
	});
	const liveActivityQuery = useQuery({
		queryKey: [LIVE_ACTIVITY_QUERY_KEY, projectId, liveSessionId],
		queryFn: () =>
			orpcClient.projects.parlume.history({
				projectId,
				sessionId: liveSessionId,
			}),
		enabled: liveSessionId !== undefined,
		retry: false,
		refetchInterval: POLL_MS,
	});
	const costBySessionId = useMemo(
		() =>
			new Map(
				(usageQuery.data?.sessions ?? []).map((entry) => [
					entry.sessionId,
					entry.costMicroUsd,
				]),
			),
		[usageQuery.data],
	);

	const stop = async (sessionId: string) => {
		setStopError(null);
		setStoppingSessionId(sessionId);
		try {
			await orpcClient.projects.parlume.stop({ projectId, sessionId });
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: [SESSIONS_QUERY_KEY, projectId],
				}),
				queryClient.invalidateQueries({
					queryKey: [USAGE_QUERY_KEY, projectId],
				}),
			]);
		} catch {
			setStopError(
				"Parlume could not leave the meeting. Try stopping it again.",
			);
		} finally {
			setStoppingSessionId(null);
		}
	};

	const isStopping = (id: string) => stoppingSessionId === id;

	return (
		<div className="space-y-6 max-sm:[&_:is(button:not([role=radio],[role=checkbox]),input,select,summary)]:min-h-11 pointer-coarse:[&_:is(button:not([role=radio],[role=checkbox]),input,select,summary)]:min-h-11">
			<header className="space-y-2.5">
				<p className="app-editorial-label">
					Voice agent · Microsoft Teams
				</p>
				<h1 className="font-serif text-3xl font-normal leading-tight tracking-tight">
					Fabric Parlume
				</h1>
				<p className="max-w-xl text-sm text-muted-foreground">
					Your project's voice agent for Microsoft Teams meetings.
				</p>
			</header>

			{stopError && (
				<p className="text-sm text-destructive" role="alert">
					{stopError}
				</p>
			)}

			<div className="flex flex-wrap items-start gap-6">
				<div className="flex min-w-0 grow-[999] basis-[35rem] flex-col gap-6">
					{liveSession ? (
						liveSession.joinedAt ? (
							<ParlumeLiveCard
								session={liveSession}
								joinedAt={liveSession.joinedAt}
								costMicroUsd={costBySessionId.get(
									liveSession.id,
								)}
								requests={liveActivityQuery.data?.items ?? []}
								requestsLoading={liveActivityQuery.isLoading}
								canStop={canEdit}
								isStopping={isStopping(liveSession.id)}
								onStop={stop}
							/>
						) : (
							<ParlumeJoiningCard
								session={liveSession}
								canStop={canEdit}
								isStopping={isStopping(liveSession.id)}
								onStop={stop}
							/>
						)
					) : canEdit ? (
						<ParlumeInviteCard projectId={projectId} />
					) : (
						<ParlumeLockedCard />
					)}
					<ParlumeActivityPanel
						projectId={projectId}
						projectBasePath={projectBasePath}
						costBySessionId={costBySessionId}
						sessions={{
							items: sessions,
							total: sessionsTotal,
							isLoading: sessionsQuery.isLoading,
							isError:
								sessionsQuery.isError &&
								!sessionsQuery.isFetchNextPageError,
							onRetry: () => sessionsQuery.refetch(),
							hasNextPage: sessionsQuery.hasNextPage,
							isFetchingNextPage:
								sessionsQuery.isFetchingNextPage,
							loadMoreFailed: sessionsQuery.isFetchNextPageError,
							onLoadMore: () => sessionsQuery.fetchNextPage(),
						}}
					/>
				</div>
				<aside className="flex min-w-0 grow basis-[18.75rem] flex-col gap-6">
					<ParlumeSpendCard
						usage={usageQuery.data}
						isLoading={usageQuery.isLoading}
						isError={usageQuery.isError}
						sessions={sessions}
						sessionCount={sessionsTotal}
						costBySessionId={costBySessionId}
					/>
					<ParlumeHowItWorks />
				</aside>
			</div>
		</div>
	);
}
