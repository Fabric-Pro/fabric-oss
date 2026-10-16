"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { ParlumeSession } from "../lib/parlume-format";
import { MONO_LABEL } from "../lib/parlume-styles";
import type { RequestKind } from "../lib/parlume-view";
import {
	HISTORY_QUERY_KEY,
	LIVE_ACTIVITY_QUERY_KEY,
	SESSIONS_QUERY_KEY,
	USAGE_QUERY_KEY,
} from "../lib/query-keys";
import { ALL_SESSIONS, ParlumeRequestsPanel } from "./ParlumeRequestsPanel";
import { ParlumeSessionsTable } from "./ParlumeSessionsTable";

type PanelTab = "sessions" | "requests";

const REFRESHED_KEYS = [
	SESSIONS_QUERY_KEY,
	USAGE_QUERY_KEY,
	HISTORY_QUERY_KEY,
	LIVE_ACTIVITY_QUERY_KEY,
];

export interface ParlumeSessionsView {
	items: ParlumeSession[];
	total: number | null;
	isLoading: boolean;
	isError: boolean;
	onRetry: () => void;
	hasNextPage: boolean;
	isFetchingNextPage: boolean;
	loadMoreFailed: boolean;
	onLoadMore: () => void;
}

function TabCount({ value }: { value: number | null }) {
	return value === null ? null : (
		<span className={`ml-2 tabular-nums ${MONO_LABEL}`}>{value}</span>
	);
}

/** Sessions and Requests share one panel, so a session can open its requests. */
export function ParlumeActivityPanel({
	projectId,
	projectBasePath,
	sessions,
	costBySessionId,
}: {
	projectId: string;
	projectBasePath: string;
	sessions: ParlumeSessionsView;
	costBySessionId: ReadonlyMap<string, number>;
}) {
	const queryClient = useQueryClient();
	const [tab, setTab] = useState<PanelTab>("sessions");
	const [sessionFilter, setSessionFilter] = useState(ALL_SESSIONS);
	const [kind, setKind] = useState<RequestKind>("all");
	const [isRefreshing, setIsRefreshing] = useState(false);
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

	// The count covers the whole project, so it is kept while another
	// session's first page is loading.
	const loadedTotal = history.data?.pages[0]?.total;
	const [requestTotal, setRequestTotal] = useState<number | null>(null);
	useEffect(() => {
		if (typeof loadedTotal === "number") {
			setRequestTotal(loadedTotal);
		}
	}, [loadedTotal]);

	const refresh = async () => {
		setIsRefreshing(true);
		try {
			await Promise.all(
				REFRESHED_KEYS.map((key) =>
					queryClient.invalidateQueries({
						queryKey: [key, projectId],
					}),
				),
			);
		} finally {
			setIsRefreshing(false);
		}
	};

	const viewRequests = (id: string) => {
		setSessionFilter(id);
		setKind("all");
		setTab("requests");
	};

	return (
		<Tabs
			value={tab}
			onValueChange={(value) =>
				setTab(value === "requests" ? "requests" : "sessions")
			}
		>
			<Card className="overflow-hidden">
				<div className="flex items-end justify-between gap-3 border-b border-border px-6">
					<TabsList className="gap-6 border-b-0">
						<TabsTrigger
							value="sessions"
							className="h-[52px] px-0 text-[15px] font-normal data-[state=active]:font-medium"
						>
							Sessions
							<TabCount value={sessions.total} />
						</TabsTrigger>
						<TabsTrigger
							value="requests"
							className="h-[52px] px-0 text-[15px] font-normal data-[state=active]:font-medium"
						>
							Requests
							<TabCount value={requestTotal} />
						</TabsTrigger>
					</TabsList>
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						className="mb-2.5 text-muted-foreground"
						aria-label="Refresh sessions and requests"
						autoLoading={false}
						onClick={refresh}
						disabled={isRefreshing}
					>
						<RefreshCwIcon
							className={
								isRefreshing ? "motion-safe:animate-spin" : ""
							}
							aria-hidden="true"
						/>
					</Button>
				</div>
				<TabsContent value="sessions" className="mt-0">
					<ParlumeSessionsTable
						sessions={sessions.items}
						costBySessionId={costBySessionId}
						projectBasePath={projectBasePath}
						isLoading={sessions.isLoading}
						isError={sessions.isError}
						onRetry={sessions.onRetry}
						hasNextPage={sessions.hasNextPage}
						isFetchingNextPage={sessions.isFetchingNextPage}
						loadMoreFailed={sessions.loadMoreFailed}
						onLoadMore={sessions.onLoadMore}
						onViewRequests={viewRequests}
					/>
				</TabsContent>
				<TabsContent value="requests" className="mt-0">
					<ParlumeRequestsPanel
						sessions={sessions.items}
						sessionFilter={sessionFilter}
						onSessionFilterChange={setSessionFilter}
						kind={kind}
						onKindChange={setKind}
						history={{
							items:
								history.data?.pages.flatMap(
									(page) => page.items,
								) ?? [],
							isLoading: history.isLoading,
							isError: history.isError,
							hasNextPage: history.hasNextPage,
							isFetchingNextPage: history.isFetchingNextPage,
							onLoadMore: () => history.fetchNextPage(),
						}}
					/>
				</TabsContent>
			</Card>
		</Tabs>
	);
}
