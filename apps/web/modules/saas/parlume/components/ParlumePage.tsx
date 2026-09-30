"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { useEffect, useMemo, useState } from "react";
import { isLiveSession, statusLabel } from "../lib/parlume-format";
import { SESSIONS_QUERY_KEY, USAGE_QUERY_KEY } from "../lib/query-keys";
import { ParlumeInviteForm } from "./ParlumeInviteForm";
import { ParlumeLiveSession } from "./ParlumeLiveSession";
import { ParlumeRequestsList } from "./ParlumeRequestsList";
import { ParlumeSessionsList } from "./ParlumeSessionsList";
import { ParlumeUsageTile } from "./ParlumeUsageTile";

const SESSIONS_POLL_MS = 10_000;

export function ParlumePage({
	projectId,
	canEdit,
}: {
	projectId: string;
	canEdit: boolean;
}) {
	const queryClient = useQueryClient();
	const [stoppingSessionId, setStoppingSessionId] = useState<string | null>(
		null,
	);
	const [stopError, setStopError] = useState<string | null>(null);
	const sessionsQuery = useQuery({
		queryKey: [SESSIONS_QUERY_KEY, projectId],
		queryFn: () => orpcClient.projects.parlume.listSessions({ projectId }),
		retry: false,
		refetchInterval: (query) =>
			query.state.data?.sessions.some(isLiveSession)
				? SESSIONS_POLL_MS
				: false,
	});
	const usageQuery = useQuery({
		queryKey: [USAGE_QUERY_KEY, projectId],
		queryFn: () => orpcClient.projects.parlume.usage({ projectId }),
		retry: false,
	});
	const sessions = sessionsQuery.data?.sessions ?? [];
	const liveSession = sessions.find(isLiveSession);
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

	const [now, setNow] = useState(() => Date.now());
	const hasLive = liveSession !== undefined;
	useEffect(() => {
		if (!hasLive) {
			return;
		}
		setNow(Date.now());
		const timer = window.setInterval(() => setNow(Date.now()), 10_000);
		return () => window.clearInterval(timer);
	}, [hasLive]);

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

	return (
		<div className="space-y-6 max-sm:[&_:is(button:not([role=switch]),input,select,summary)]:min-h-11 pointer-coarse:[&_:is(button:not([role=switch]),input,select,summary)]:min-h-11">
			<header className="flex flex-wrap items-start justify-between gap-3">
				<div className="space-y-1">
					<h1 className="text-2xl font-semibold">Fabric Parlume</h1>
					<p className="text-sm text-muted-foreground">
						Your project's voice agent for Microsoft Teams meetings.
					</p>
				</div>
				<Badge variant={liveSession ? "success" : "info"}>
					{liveSession
						? `Live · ${statusLabel(liveSession.status)}`
						: "Not in a meeting"}
				</Badge>
			</header>

			{stopError && (
				<p className="text-sm text-destructive" role="alert">
					{stopError}
				</p>
			)}
			{liveSession && (
				<ParlumeLiveSession
					session={liveSession}
					now={now}
					canStop={canEdit}
					isStopping={stoppingSessionId === liveSession.id}
					onStop={stop}
				/>
			)}

			<div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
				<div className="space-y-6">
					{canEdit ? (
						<ParlumeInviteForm
							projectId={projectId}
							hasLiveSession={hasLive}
						/>
					) : (
						<p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
							Only project administrators can invite or stop
							Parlume.
						</p>
					)}
					<ParlumeSessionsList
						sessions={sessions}
						costBySessionId={costBySessionId}
						isLoading={sessionsQuery.isLoading}
						isError={sessionsQuery.isError}
						onRetry={() => sessionsQuery.refetch()}
					/>
					<ParlumeRequestsList
						projectId={projectId}
						sessions={sessions}
					/>
				</div>
				<div className="space-y-6">
					<ParlumeUsageTile
						usage={usageQuery.data}
						isLoading={usageQuery.isLoading}
						isError={usageQuery.isError}
					/>
				</div>
			</div>
		</div>
	);
}
