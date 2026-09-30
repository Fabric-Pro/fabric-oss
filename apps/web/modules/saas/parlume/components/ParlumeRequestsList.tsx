"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Label } from "@ui/components/label";
import { useState } from "react";
import {
	formatTimestamp,
	modeLabel,
	type ParlumeSession,
} from "../lib/parlume-format";
import { HISTORY_QUERY_KEY } from "../lib/query-keys";

const ALL_SESSIONS = "all";

export function ParlumeRequestsList({
	projectId,
	sessions,
}: {
	projectId: string;
	sessions: ParlumeSession[];
}) {
	const [sessionFilter, setSessionFilter] = useState(ALL_SESSIONS);
	const sessionId =
		sessionFilter === ALL_SESSIONS ? undefined : sessionFilter;
	const firstPage: { id: string; createdAt: Date } | undefined = undefined;
	const history = useInfiniteQuery({
		queryKey: [HISTORY_QUERY_KEY, projectId, sessionId ?? ALL_SESSIONS],
		initialPageParam: firstPage,
		queryFn: ({
			pageParam,
		}: {
			pageParam: { id: string; createdAt: Date } | undefined;
		}) =>
			orpcClient.projects.parlume.history({
				projectId,
				sessionId,
				before: pageParam,
			}),
		getNextPageParam: (page) => page.nextCursor ?? undefined,
		retry: false,
	});
	const items = history.data?.pages.flatMap((page) => page.items) ?? [];

	return (
		<Card>
			<CardHeader className="space-y-1.5 p-6 pb-4">
				<CardTitle className="text-base">Requests</CardTitle>
				<p className="text-sm text-muted-foreground">
					Review meeting questions, requested actions, approvals and
					results. Speaker labels come from the meeting provider.
				</p>
			</CardHeader>
			<CardContent className="space-y-4 p-6 pt-0">
				<div className="flex flex-wrap items-end justify-between gap-3">
					<div className="space-y-2">
						<Label htmlFor="parlume-session-filter">Session</Label>
						<select
							id="parlume-session-filter"
							className="h-9 w-full rounded-md border bg-background px-3 text-sm sm:w-72"
							value={sessionFilter}
							onChange={(event) =>
								setSessionFilter(event.target.value)
							}
						>
							<option value={ALL_SESSIONS}>All sessions</option>
							{sessions.map((session) => (
								<option key={session.id} value={session.id}>
									{session.agentLabel} ·{" "}
									{formatTimestamp(session.createdAt)}
								</option>
							))}
						</select>
					</div>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => history.refetch()}
						disabled={history.isFetching}
					>
						Refresh
					</Button>
				</div>
				{history.isLoading ? (
					<output className="block text-sm text-muted-foreground">
						Loading requests…
					</output>
				) : history.isError ? (
					<p role="alert" className="text-sm text-destructive">
						Could not load Parlume requests. Try refreshing.
					</p>
				) : items.length === 0 ? (
					<p className="py-6 text-center text-sm text-muted-foreground">
						No Parlume requests yet.
					</p>
				) : (
					<ol className="space-y-3">
						{items.map((turn) => (
							<li
								key={turn.id}
								className="space-y-2 rounded-md border p-3 text-sm"
							>
								<div className="flex flex-wrap items-baseline justify-between gap-2">
									<p className="font-medium">
										{turn.speakerName ??
											"Unidentified attendee"}
									</p>
									<time
										className="text-xs text-muted-foreground"
										dateTime={new Date(
											turn.createdAt,
										).toISOString()}
									>
										{formatTimestamp(turn.createdAt)}
									</time>
								</div>
								<p className="text-xs text-muted-foreground">
									{turn.session.agentLabel} ·{" "}
									{modeLabel(turn.session.toolsReadOnly)} ·{" "}
									{turn.status.toLowerCase()}
								</p>
								<p className="whitespace-pre-wrap break-words">
									{turn.requestText}
								</p>
								{turn.responseText && (
									<p className="whitespace-pre-wrap break-words border-l-2 pl-3 text-muted-foreground">
										{turn.responseText}
									</p>
								)}
								{turn.error && (
									<p className="text-destructive">
										{turn.error}
									</p>
								)}
								{turn.actions.map((action) => (
									<details
										key={action.id}
										className="rounded-md bg-muted/40 px-3 py-2"
									>
										<summary className="min-h-6 cursor-pointer font-medium">
											Action ·{" "}
											{action.status ===
												"AWAITING_CONFIRMATION" &&
											new Date(action.expiresAt) <=
												new Date()
												? "expired"
												: action.status
														.toLowerCase()
														.replaceAll("_", " ")}
										</summary>
										<div className="mt-2 space-y-2">
											<p className="whitespace-pre-wrap break-words">
												{action.summary}
											</p>
											<p className="text-xs text-muted-foreground">
												Requested{" "}
												{formatTimestamp(
													action.createdAt,
												)}
												{action.confirmedAt
													? ` · Confirmed ${formatTimestamp(action.confirmedAt)}`
													: ""}
												{action.completedAt
													? ` · Finished ${formatTimestamp(action.completedAt)}`
													: ""}
											</p>
											<section aria-label="Exact action details">
												<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">
													{JSON.stringify(
														action.arguments,
														null,
														2,
													)}
												</pre>
											</section>
											{action.outcome && (
												<p className="whitespace-pre-wrap break-words text-muted-foreground">
													{action.outcome}
												</p>
											)}
										</div>
									</details>
								))}
							</li>
						))}
					</ol>
				)}
				{history.hasNextPage && (
					<Button
						type="button"
						variant="outline"
						onClick={() => history.fetchNextPage()}
						disabled={history.isFetchingNextPage}
					>
						{history.isFetchingNextPage
							? "Loading…"
							: "Load older requests"}
					</Button>
				)}
			</CardContent>
		</Card>
	);
}
