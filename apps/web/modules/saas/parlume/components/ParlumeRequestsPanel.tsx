"use client";

import { Button } from "@ui/components/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import {
	formatTimestamp,
	isLiveSession,
	type ParlumeRequest,
	type ParlumeSession,
} from "../lib/parlume-format";
import { matchesKind, type RequestKind } from "../lib/parlume-view";
import { ParlumeRequestItem } from "./ParlumeRequestItem";

export const ALL_SESSIONS = "all";

const KINDS: ReadonlyArray<{ id: RequestKind; label: string }> = [
	{ id: "all", label: "All" },
	{ id: "question", label: "Questions" },
	{ id: "action", label: "Actions" },
];

export interface ParlumeHistoryView {
	items: ParlumeRequest[];
	isLoading: boolean;
	isError: boolean;
	hasNextPage: boolean;
	isFetchingNextPage: boolean;
	onLoadMore: () => void;
}

/** Everything the meetings asked Parlume, filtered by session and by kind. */
export function ParlumeRequestsPanel({
	sessions,
	sessionFilter,
	onSessionFilterChange,
	kind,
	onKindChange,
	history,
}: {
	sessions: ParlumeSession[];
	sessionFilter: string;
	onSessionFilterChange: (sessionId: string) => void;
	kind: RequestKind;
	onKindChange: (kind: RequestKind) => void;
	history: ParlumeHistoryView;
}) {
	const items = history.items.filter((request) => matchesKind(request, kind));
	const filtered = sessionFilter !== ALL_SESSIONS || kind !== "all";
	const now = Date.now();

	return (
		<div>
			<div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/40 px-6 py-3.5">
				<Select
					value={sessionFilter}
					onValueChange={onSessionFilterChange}
				>
					<SelectTrigger
						aria-label="Session"
						className="h-8 min-w-50 flex-[0_1_18.75rem] text-[13px]"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={ALL_SESSIONS}>
							All sessions
						</SelectItem>
						{sessions.map((session) => (
							<SelectItem key={session.id} value={session.id}>
								{formatTimestamp(session.createdAt)} ·{" "}
								{session.agentLabel}
								{isLiveSession(session) ? " (live)" : ""}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<fieldset
					aria-label="Request type"
					className="inline-flex min-w-0 gap-0.5 rounded-md bg-muted p-0.5"
				>
					{KINDS.map((option) => {
						const active = kind === option.id;
						return (
							<button
								key={option.id}
								type="button"
								aria-pressed={active}
								onClick={() => onKindChange(option.id)}
								className={`h-7 rounded-[5px] border px-3 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring ${
									active
										? "border-border bg-card text-foreground"
										: "border-transparent text-muted-foreground hover:text-foreground"
								}`}
							>
								{option.label}
							</button>
						);
					})}
				</fieldset>
			</div>
			{history.isLoading ? (
				<output className="block px-6 py-5 text-sm text-muted-foreground">
					Loading requests…
				</output>
			) : history.isError ? (
				<p role="alert" className="px-6 py-5 text-sm text-destructive">
					Could not load Parlume requests. Try refreshing.
				</p>
			) : items.length === 0 ? (
				<p className="px-6 py-10 text-center text-sm text-muted-foreground">
					{filtered
						? "No requests match this filter."
						: "No Parlume requests yet."}
				</p>
			) : (
				<ol>
					{items.map((request) => (
						<ParlumeRequestItem
							key={request.id}
							request={request}
							now={now}
						/>
					))}
				</ol>
			)}
			{history.hasNextPage && (
				<div className="px-6 py-4">
					<Button
						type="button"
						variant="outline"
						size="sm"
						autoLoading={false}
						onClick={history.onLoadMore}
						disabled={history.isFetchingNextPage}
					>
						{history.isFetchingNextPage
							? "Loading…"
							: "Load older requests"}
					</Button>
				</div>
			)}
		</div>
	);
}
