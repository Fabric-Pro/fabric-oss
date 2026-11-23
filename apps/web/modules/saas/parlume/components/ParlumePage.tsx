"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import {
	useInfiniteQuery,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Card } from "@ui/components/card";
import { useEffect, useMemo, useState } from "react";
import { isLiveSession, isSessionChanging } from "../lib/parlume-format";
import {
	LIVE_ACTIVITY_QUERY_KEY,
	SESSIONS_QUERY_KEY,
	USAGE_QUERY_KEY,
} from "../lib/query-keys";
import { ParlumeActivityPanel } from "./ParlumeActivityPanel";
import { ParlumeAskComposer } from "./ParlumeAskComposer";
import { ParlumeConfidentialControl } from "./ParlumeConfidentialControl";
import { ParlumeHowItWorks } from "./ParlumeHowItWorks";
import { ParlumeInviteCard } from "./ParlumeInviteCard";
import { ParlumeJoiningCard } from "./ParlumeJoiningCard";
import { ParlumeLiveCard } from "./ParlumeLiveCard";
import { ParlumeLiveTranscript } from "./ParlumeLiveTranscript";
import { ParlumeLockedCard } from "./ParlumeLockedCard";
import { ParlumeSpendCard } from "./ParlumeSpendCard";
import { ParlumeSuggestionsList } from "./ParlumeSuggestionsList";
import { ParlumeVoiceControls } from "./ParlumeVoiceControls";

const POLL_MS = 10_000;

export function ParlumePage({
	projectId,
	projectBasePath,
	settingsBasePath,
	canEdit,
	canAct = false,
}: {
	projectId: string;
	/** `/app/{org}/projects/{id}`, where a session's transcript lives under `/contexts`. */
	projectBasePath: string;
	/** `/app/{org}/settings`, where a missing setup item is fixed. */
	settingsBasePath: string;
	canEdit: boolean;
	/**
	 * A project member (PROJECT_UPDATE), not a viewer: may ask Parlume on this
	 * page and use a suggestion's buttons, as the procedures require.
	 */
	canAct?: boolean;
}) {
	const queryClient = useQueryClient();
	// A "Say it" link in the meeting chat opens the page on `?suggestion=P3`.
	const [highlightTag, setHighlightTag] = useState<string | null>(null);
	useEffect(() => {
		setHighlightTag(
			new URLSearchParams(window.location.search).get("suggestion"),
		);
	}, []);
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
		// Also while notes are being written, so new notes appear without a
		// reload.
		refetchInterval: (query) => {
			const now = Date.now();
			return query.state.data?.pages[0]?.sessions.some((session) =>
				isSessionChanging(session, now),
			)
				? POLL_MS
				: false;
		},
	});
	const sessions =
		sessionsQuery.data?.pages.flatMap((page) => page.sessions) ?? [];
	// The live session is the newest, so it is always on page 1.
	const liveSession =
		sessionsQuery.data?.pages[0]?.sessions.find(isLiveSession);
	const liveSessionId = liveSession?.id;
	const sessionsTotal = sessionsQuery.data?.pages[0]?.total ?? null;

	// Spend is for the people who can invite Parlume, which is what incurs it;
	// the usage procedure refuses everyone else, so others never ask for it.
	const usageQuery = useQuery({
		queryKey: [USAGE_QUERY_KEY, projectId],
		queryFn: () => orpcClient.projects.parlume.usage({ projectId }),
		enabled: canEdit,
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
				<h1 className="text-xl font-semibold leading-tight tracking-tight">
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
								showSpend={canEdit}
								requests={liveActivityQuery.data?.items ?? []}
								requestsLoading={liveActivityQuery.isLoading}
								canStop={canEdit}
								isStopping={isStopping(liveSession.id)}
								onStop={stop}
								voiceControls={
									<>
										<ParlumeVoiceControls
											projectId={projectId}
											session={liveSession}
										/>
										<ParlumeConfidentialControl
											projectId={projectId}
											session={liveSession}
											className="px-6 pb-5"
										/>
									</>
								}
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
						<ParlumeInviteCard
							projectId={projectId}
							settingsBasePath={settingsBasePath}
						/>
					) : (
						<ParlumeLockedCard />
					)}
					{liveSession?.joinedAt && canAct && (
						<ParlumeAskComposer
							projectId={projectId}
							sessionId={liveSession.id}
							projectBasePath={projectBasePath}
							requests={liveActivityQuery.data?.items ?? []}
						/>
					)}
					{liveSession?.joinedAt &&
						liveSession.suggestionsEnabled && (
							<Card className="p-6">
								<ParlumeSuggestionsList
									projectId={projectId}
									sessionId={liveSession.id}
									refetchInterval={POLL_MS}
									variant="card"
									controls={
										canAct &&
										liveSession.status === "ACTIVE"
											? {
													guestsPresent:
														liveSession.guestsPresent,
													highlightTag,
												}
											: null
									}
								/>
							</Card>
						)}
					{liveSession?.joinedAt && liveSession.canReadTranscript && (
						<ParlumeLiveTranscript
							projectId={projectId}
							sessionId={liveSession.id}
							refetchInterval={POLL_MS}
						/>
					)}
					<ParlumeActivityPanel
						projectId={projectId}
						projectBasePath={projectBasePath}
						costBySessionId={costBySessionId}
						showSpend={canEdit}
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
					{canEdit && (
						<ParlumeSpendCard
							usage={usageQuery.data}
							isLoading={usageQuery.isLoading}
							isError={usageQuery.isError}
							sessions={sessions}
							sessionCount={sessionsTotal}
							costBySessionId={costBySessionId}
						/>
					)}
					<ParlumeHowItWorks />
				</aside>
			</div>
		</div>
	);
}
