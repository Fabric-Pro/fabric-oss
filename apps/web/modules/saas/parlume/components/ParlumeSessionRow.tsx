"use client";

import { Button } from "@ui/components/button";
import { Markdown } from "@ui/components/markdown";
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
import { MONO_LABEL } from "../lib/parlume-styles";
import { sessionOutcome, TONE_DOT, TONE_TEXT } from "../lib/parlume-view";

function hasNotesBlock(session: ParlumeSession): boolean {
	return Boolean(session.notes || session.transcriptContextId);
}

/** A finished session opens only if there is something in it to read. */
function hasDetails(session: ParlumeSession): boolean {
	return (
		Boolean(session.lastError) ||
		hasNotesBlock(session) ||
		session.requestCount > 0
	);
}

function notesPlaceholder(session: ParlumeSession): string {
	return session.notesStatus === "FAILED"
		? "Meeting notes are unavailable."
		: "Preparing meeting notes…";
}

function SessionDetails({
	session,
	projectBasePath,
	onViewRequests,
}: {
	session: ParlumeSession;
	projectBasePath: string;
	onViewRequests: (sessionId: string) => void;
}) {
	return (
		<div className="space-y-3.5 px-6 pt-1 pb-5">
			{session.lastError && (
				<p className="text-sm text-destructive">{session.lastError}</p>
			)}
			{hasNotesBlock(session) && (
				<div className="max-w-2xl space-y-1.5">
					<span className={MONO_LABEL}>Meeting notes</span>
					{session.notes ? (
						<Markdown className="text-foreground prose-headings:mt-3 prose-headings:mb-1 prose-headings:text-sm prose-headings:font-medium prose-p:my-1 prose-ul:my-1 prose-li:my-0">
							{session.notes}
						</Markdown>
					) : (
						<p className="text-sm text-muted-foreground">
							{notesPlaceholder(session)}
						</p>
					)}
				</div>
			)}
			{(session.transcriptContextId || session.requestCount > 0) && (
				<div className="flex flex-wrap gap-2">
					{session.transcriptContextId && (
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

function lengthOf(session: ParlumeSession, now: number): string {
	if (session.endedAt) {
		return formatDuration(session.joinedAt, session.endedAt);
	}
	return isLiveSession(session) ? formatDuration(session.joinedAt, now) : "—";
}

/** A session's row, and the detail row under it while it is open. */
export function ParlumeSessionRow({
	session,
	cost,
	now,
	expanded,
	onToggle,
	projectBasePath,
	onViewRequests,
}: {
	session: ParlumeSession;
	cost: number | undefined;
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
				<TableCell className="py-3.5 text-right tabular-nums">
					{cost === undefined ? "—" : formatCost(cost)}
				</TableCell>
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
					<TableCell id={detailsId} colSpan={6} className="p-0">
						<SessionDetails
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
