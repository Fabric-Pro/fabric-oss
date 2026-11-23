"use client";

import {
	PARLUME_NOTE_KINDS,
	type ParlumeNoteKind,
} from "@repo/utils/parlume-notes";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Markdown } from "@ui/components/markdown";
import { RefreshCwIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { ParlumeSession } from "../lib/parlume-format";
import { MONO_LABEL } from "../lib/parlume-styles";
import { SESSIONS_QUERY_KEY } from "../lib/query-keys";

type NoteItem = ParlumeSession["notesItems"][number];

const HEADINGS: Record<ParlumeNoteKind, string> = {
	discussion: "Discussion",
	decision: "Decisions",
	action: "Action items",
	question: "Open questions",
};

function notesPlaceholder(session: ParlumeSession): string {
	switch (session.notesStatus) {
		case "FAILED":
			return "Meeting notes are unavailable.";
		case "COMPLETED":
			return "No notes could be tied to a line of this meeting's transcript.";
		default:
			return "Preparing meeting notes…";
	}
}

/** Over earlier notes: they are being written again, or that failed. */
function rewriteNotice(session: ParlumeSession): string | null {
	const hasNotes = Boolean(session.notes) || session.notesItems.length > 0;
	if (!hasNotes) {
		return null;
	}
	if (session.notesStatus === "PENDING") {
		return "Writing the notes again…";
	}
	if (session.notesStatus === "FAILED") {
		return "The notes could not be written again. These are the earlier notes.";
	}
	return null;
}

/** An action item's owner and due date, as far as its line names them. */
function actionDetails(item: NoteItem): string {
	const details = [
		item.tentativeOwnerName ? `Owner: ${item.tentativeOwnerName}` : null,
		item.dueHint ? `Due: ${item.dueHint}` : null,
	].filter((detail): detail is string => detail !== null);
	return details.join(", ");
}

/** Where proposing an action item stands, once asked. */
type ProposeState =
	| { kind: "idle" }
	| { kind: "busy" }
	| { kind: "done"; alreadyProposed: boolean }
	| { kind: "failed"; message: string };

/**
 * Files an action item as a ticket proposal, which waits for approval in
 * the Proposal Inbox with a link to the item's transcript line.
 */
function ProposeActionItem({
	projectId,
	sessionId,
	item,
}: {
	projectId: string;
	sessionId: string;
	item: NoteItem;
}) {
	const [state, setState] = useState<ProposeState>({ kind: "idle" });

	const propose = async () => {
		setState({ kind: "busy" });
		try {
			const result = await orpcClient.projects.parlume.proposeActionItem({
				projectId,
				sessionId,
				anchorLine: item.anchorLine,
				text: item.text,
			});
			setState({
				kind: "done",
				alreadyProposed: result.status === "already-proposed",
			});
		} catch (cause) {
			setState({
				kind: "failed",
				message:
					cause instanceof Error && cause.message
						? cause.message
						: "The action item could not be proposed. Try again.",
			});
		}
	};

	if (state.kind === "done") {
		return (
			<span className="ml-2 text-xs text-muted-foreground" role="status">
				{state.alreadyProposed
					? "Already in the Proposal Inbox."
					: "Proposed to the Proposal Inbox."}
			</span>
		);
	}
	return (
		<>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				className="ml-2 h-auto px-1.5 py-0.5 text-xs"
				disabled={state.kind === "busy"}
				onClick={propose}
				aria-label={`Propose "${item.text}" as a ticket`}
			>
				Propose
			</Button>
			{state.kind === "failed" && (
				<span role="alert" className="ml-2 text-xs text-destructive">
					{state.message}
				</span>
			)}
		</>
	);
}

function NoteLine({
	item,
	transcriptHref,
	propose,
}: {
	item: NoteItem;
	transcriptHref: string | null;
	/** The session, for a viewer who may propose its action items. */
	propose: { projectId: string; sessionId: string } | null;
}) {
	const details = actionDetails(item);
	return (
		<li>
			{item.text}
			{details && (
				<span className="text-muted-foreground">{` (${details})`}</span>
			)}
			{transcriptHref && (
				<Link
					href={`${transcriptHref}#t-${item.anchorLine}`}
					className="ml-2 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
					aria-label={`Open the transcript at line ${item.anchorLine}`}
				>
					Line {item.anchorLine}
				</Link>
			)}
			{propose && item.kind === "action" && (
				<ProposeActionItem
					projectId={propose.projectId}
					sessionId={propose.sessionId}
					item={item}
				/>
			)}
		</li>
	);
}

function AnchoredNotes({
	items,
	transcriptHref,
	propose,
}: {
	items: NoteItem[];
	/** The transcript reader, for a viewer who may open it. */
	transcriptHref: string | null;
	propose: { projectId: string; sessionId: string } | null;
}) {
	return (
		<div className="space-y-3">
			{PARLUME_NOTE_KINDS.map((kind) => {
				const ofKind = items.filter((item) => item.kind === kind);
				if (ofKind.length === 0) {
					return null;
				}
				return (
					<section key={kind} className="space-y-1">
						<h4 className="text-sm font-medium">
							{HEADINGS[kind]}
						</h4>
						<ul className="list-disc space-y-1 pl-5 text-sm text-foreground">
							{ofKind.map((item) => (
								<NoteLine
									key={`${item.anchorLine}-${item.text}`}
									item={item}
									transcriptHref={transcriptHref}
									propose={propose}
								/>
							))}
						</ul>
					</section>
				);
			})}
		</div>
	);
}

function RegenerateNotes({
	projectId,
	sessionId,
}: {
	projectId: string;
	sessionId: string;
}) {
	const queryClient = useQueryClient();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const regenerate = async () => {
		setError(null);
		setBusy(true);
		try {
			await orpcClient.projects.parlume.regenerateNotes({
				projectId,
				sessionId,
			});
			await queryClient.invalidateQueries({
				queryKey: [SESSIONS_QUERY_KEY, projectId],
			});
		} catch (cause) {
			setError(
				cause instanceof Error && cause.message
					? cause.message
					: "The notes could not be written again. Try again.",
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="space-y-2">
			<Button
				type="button"
				variant="outline"
				size="sm"
				disabled={busy}
				onClick={regenerate}
			>
				<RefreshCwIcon aria-hidden="true" />
				Regenerate notes
			</Button>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
		</div>
	);
}

/**
 * A finished session's notes: each note with a link to the transcript line
 * it rests on, for a viewer who may open the transcript. Notes written
 * before they were anchored show as they were written.
 */
export function ParlumeSessionNotes({
	projectId,
	session,
	transcriptHref,
}: {
	projectId: string;
	session: ParlumeSession;
	transcriptHref: string | null;
}) {
	const notice = rewriteNotice(session);
	return (
		<div className="max-w-2xl space-y-1.5">
			<span className={MONO_LABEL}>Meeting notes</span>
			{notice && (
				<p className="text-sm text-muted-foreground">{notice}</p>
			)}
			{session.notesItems.length > 0 ? (
				<AnchoredNotes
					items={session.notesItems}
					transcriptHref={transcriptHref}
					propose={
						session.canProposeActionItems
							? { projectId, sessionId: session.id }
							: null
					}
				/>
			) : session.notes ? (
				<Markdown className="text-foreground prose-headings:mt-3 prose-headings:mb-1 prose-headings:text-sm prose-headings:font-medium prose-p:my-1 prose-ul:my-1 prose-li:my-0">
					{session.notes}
				</Markdown>
			) : (
				<p className="text-sm text-muted-foreground">
					{notesPlaceholder(session)}
				</p>
			)}
			{session.canRegenerateNotes && (
				<RegenerateNotes projectId={projectId} sessionId={session.id} />
			)}
		</div>
	);
}
