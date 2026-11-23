"use client";

import { Button } from "@ui/components/button";
import { TableCell, TableRow } from "@ui/components/table";
import { ArrowRightIcon, ChevronRightIcon, FileTextIcon } from "lucide-react";
import Link from "next/link";
import { Fragment } from "react";
import {
	formatCost,
	formatDuration,
	formatTimestamp,
	isLiveSession,
	modeLabel,
	type ParlumeSession,
} from "../lib/parlume-format";
import { sessionOutcome, TONE_DOT, TONE_TEXT } from "../lib/parlume-view";
import { ParlumeConfidentialControl } from "./ParlumeConfidentialControl";
import { ParlumeDeleteSession } from "./ParlumeDeleteSession";
import { ParlumeSessionNotes } from "./ParlumeSessionNotes";
import { ParlumeSuggestionsList } from "./ParlumeSuggestionsList";

function hasNotesBlock(session: ParlumeSession): boolean {
	return Boolean(session.notes || session.transcriptContextId);
}

/** A finished session opens only if there is something in it to read. */
function hasDetails(session: ParlumeSession): boolean {
	return (
		Boolean(session.lastError) ||
		session.confidential ||
		session.canMarkConfidential ||
		hasNotesBlock(session) ||
		session.requestCount > 0 ||
		session.suggestionCount > 0
	);
}

function SessionDetails({
	projectId,
	session,
	projectBasePath,
	onViewRequests,
}: {
	projectId: string;
	session: ParlumeSession;
	projectBasePath: string;
	onViewRequests: (sessionId: string) => void;
}) {
	const transcriptReadable =
		session.canReadTranscript && !session.transcriptDeletedAt;
	const deletable =
		session.canDeleteSession &&
		((session.transcriptContextId !== null &&
			!session.transcriptDeletedAt) ||
			session.requestCount > 0 ||
			session.suggestionCount > 0);
	return (
		<div className="space-y-3.5 px-6 pt-1 pb-5">
			{session.lastError && (
				<p className="text-sm text-destructive">{session.lastError}</p>
			)}
			<ParlumeConfidentialControl
				projectId={projectId}
				session={session}
				className="max-w-2xl"
			/>
			{!session.contentWithheld && hasNotesBlock(session) && (
				<ParlumeSessionNotes
					projectId={projectId}
					session={session}
					transcriptHref={
						session.transcriptContextId && transcriptReadable
							? `${projectBasePath}/contexts/${session.transcriptContextId}`
							: null
					}
				/>
			)}
			{session.transcriptContextId &&
				!transcriptReadable &&
				!session.contentWithheld && (
					<p className="text-sm text-muted-foreground">
						{session.transcriptDeletedAt
							? "The transcript was deleted. The notes stay."
							: "Only the people invited to this meeting, the person who invited Parlume and project managers can open the transcript."}
					</p>
				)}
			{((session.transcriptContextId && transcriptReadable) ||
				session.requestCount > 0) && (
				<div className="flex flex-wrap gap-2">
					{session.transcriptContextId && transcriptReadable && (
						<Button asChild variant="outline" size="sm">
							<Link
								href={`${projectBasePath}/contexts/${session.transcriptContextId}`}
							>
								<FileTextIcon aria-hidden="true" />
								Open transcript
							</Link>
						</Button>
					)}
					{session.requestCount > 0 && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => onViewRequests(session.id)}
						>
							View {session.requestCount}{" "}
							{session.requestCount === 1
								? "request"
								: "requests"}
							<ArrowRightIcon aria-hidden="true" />
						</Button>
					)}
				</div>
			)}
			{session.suggestionCount > 0 && (
				<div className="max-w-2xl">
					<ParlumeSuggestionsList
						projectId={projectId}
						sessionId={session.id}
						refetchInterval={false}
						variant="details"
					/>
				</div>
			)}
			{deletable && (
				<ParlumeDeleteSession
					projectId={projectId}
					sessionId={session.id}
				/>
			)}
		</div>
	);
}

function Outcome({ session }: { session: ParlumeSession }) {
	const outcome = sessionOutcome(session);
	return (
		<span className="flex items-center gap-2">
			<span
				aria-hidden="true"
				className={`size-[7px] shrink-0 rounded-full ${TONE_DOT[outcome.tone]}`}
			/>
			<span
				className={
					outcome.tone === "neutral" ? "" : TONE_TEXT[outcome.tone]
				}
			>
				{outcome.label}
			</span>
		</span>
	);
}

/** A session the series' auto-join started rather than a person's invite. */
function autoJoinedLabel(
	session: Pick<ParlumeSession, "linkedMeeting">,
): string {
	return `Auto-joined · ${session.linkedMeeting?.subject ?? "linked meeting series"}`;
}

function lengthOf(session: ParlumeSession, now: number): string {
	if (session.endedAt) {
		return formatDuration(session.joinedAt, session.endedAt);
	}
	return isLiveSession(session) ? formatDuration(session.joinedAt, now) : "—";
}

/** A session's row, and the detail row under it while it is open. */
export function ParlumeSessionRow({
	projectId,
	session,
	cost,
	showSpend,
	now,
	expanded,
	onToggle,
	projectBasePath,
	onViewRequests,
}: {
	projectId: string;
	session: ParlumeSession;
	cost: number | undefined;
	/** Whether this viewer may see spend; the column is left out otherwise. */
	showSpend: boolean;
	now: number;
	expanded: boolean;
	onToggle: () => void;
	projectBasePath: string;
	onViewRequests: (sessionId: string) => void;
}) {
	const expandable = !isLiveSession(session) && hasDetails(session);
	const detailsId = `parlume-session-${session.id}-details`;
	const identity = (
		<>
			<span className="block">
				{formatTimestamp(session.joinedAt ?? session.createdAt)}
			</span>
			<span className="block break-words text-xs text-muted-foreground">
				{session.agentLabel}
			</span>
			{session.trigger === "AUTO" && (
				<span className="block break-words text-xs text-muted-foreground">
					{autoJoinedLabel(session)}
				</span>
			)}
		</>
	);
	return (
		<Fragment>
			<TableRow
				className={
					expandable
						? `cursor-pointer ${expanded ? "bg-muted/40" : ""}`
						: "hover:bg-transparent"
				}
				onClick={expandable ? onToggle : undefined}
			>
				<TableCell className="min-w-40 py-3.5 pl-6">
					{expandable ? (
						<button
							type="button"
							className="block w-full text-left outline-none focus-visible:underline"
							aria-expanded={expanded}
							aria-controls={detailsId}
						>
							{identity}
						</button>
					) : (
						identity
					)}
				</TableCell>
				<TableCell className="py-3.5 text-[13px] text-muted-foreground max-sm:hidden">
					{modeLabel(session.toolsReadOnly)}
				</TableCell>
				<TableCell className="py-3.5 tabular-nums max-sm:hidden">
					{lengthOf(session, now)}
				</TableCell>
				<TableCell className="py-3.5">
					<Outcome session={session} />
				</TableCell>
				{showSpend && (
					<TableCell className="py-3.5 text-right tabular-nums">
						{cost === undefined ? "—" : formatCost(cost)}
						{cost !== undefined && isLiveSession(session) && (
							<span className="block text-xs text-muted-foreground">
								so far
							</span>
						)}
					</TableCell>
				)}
				<TableCell className="w-10 py-3.5 pr-6">
					{expandable && (
						<ChevronRightIcon
							className={`size-4 text-muted-foreground motion-safe:transition-transform ${expanded ? "rotate-90" : ""}`}
							aria-hidden="true"
						/>
					)}
				</TableCell>
			</TableRow>
			{expandable && expanded && (
				<TableRow className="bg-muted/40 hover:bg-muted/40">
					<TableCell
						id={detailsId}
						colSpan={showSpend ? 6 : 5}
						className="p-0"
					>
						<SessionDetails
							projectId={projectId}
							session={session}
							projectBasePath={projectBasePath}
							onViewRequests={onViewRequests}
						/>
					</TableCell>
				</TableRow>
			)}
		</Fragment>
	);
}
