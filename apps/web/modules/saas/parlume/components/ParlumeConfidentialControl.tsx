"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { LockIcon, LockOpenIcon } from "lucide-react";
import { useState } from "react";
import { isLiveSession, type ParlumeSession } from "../lib/parlume-format";
import {
	HISTORY_QUERY_KEY,
	SESSIONS_QUERY_KEY,
	SUGGESTIONS_QUERY_KEY,
} from "../lib/query-keys";

type ConfidentialSession = Pick<
	ParlumeSession,
	| "id"
	| "status"
	| "confidential"
	| "confidentialSince"
	| "confidentialBy"
	| "canMarkConfidential"
	| "canClearConfidential"
>;

/** What the control says about the meeting's confidential mark now. */
function confidentialStatus(
	session: Pick<
		ParlumeSession,
		"status" | "confidential" | "confidentialSince" | "confidentialBy"
	>,
): string | null {
	const by = session.confidentialBy ?? "a meeting member";
	if (session.confidentialSince) {
		return `Confidential since ${new Date(session.confidentialSince).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}, marked by ${by}. What is said now is kept to the people in this meeting and the project's managers.`;
	}
	if (session.confidential) {
		return isLiveSession(session)
			? `Part of this meeting is confidential. Its notes, requests and suggestions are kept to the people in it and the project's managers.`
			: `This meeting is confidential. Its notes, requests, suggestions and transcript are kept to the people in it and the project's managers.`;
	}
	return null;
}

/**
 * Starts or ends a live meeting's confidential part, or marks or clears a
 * finished meeting as a whole. Marking is for the inviter, a project manager
 * or anyone who was in the meeting; clearing for the inviter or a manager.
 */
export function ParlumeConfidentialControl({
	projectId,
	session,
	className,
}: {
	projectId: string;
	session: ConfidentialSession;
	className?: string;
}) {
	const queryClient = useQueryClient();
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const live = isLiveSession(session);
	// Live, the control follows the open part; afterwards, the whole meeting.
	const marked = live
		? session.confidentialSince !== null
		: session.confidential;
	const allowed = marked
		? session.canClearConfidential
		: session.canMarkConfidential;
	const status = confidentialStatus(session);

	const toggle = async () => {
		setError(null);
		setPending(true);
		try {
			await orpcClient.projects.parlume.setConfidential({
				projectId,
				sessionId: session.id,
				confidential: !marked,
			});
			await Promise.all(
				[
					SESSIONS_QUERY_KEY,
					HISTORY_QUERY_KEY,
					SUGGESTIONS_QUERY_KEY,
				].map((key) =>
					queryClient.invalidateQueries({
						queryKey: [key, projectId],
					}),
				),
			);
		} catch (cause) {
			setError(
				cause instanceof Error && cause.message
					? cause.message
					: "The confidential mark could not be changed. Try again.",
			);
		} finally {
			setPending(false);
		}
	};

	if (!status && !allowed) {
		return null;
	}
	const label = live
		? marked
			? "End confidential part"
			: "Confidential from now"
		: marked
			? "Remove confidential mark"
			: "Mark meeting confidential";
	return (
		<div className={`space-y-2 ${className ?? ""}`}>
			{status && (
				<p className="flex items-start gap-2 text-sm text-muted-foreground">
					<LockIcon
						className="mt-0.5 size-4 shrink-0"
						aria-hidden="true"
					/>
					<span>{status}</span>
				</p>
			)}
			{allowed && (
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={pending}
					onClick={toggle}
				>
					{marked ? (
						<LockOpenIcon aria-hidden="true" />
					) : (
						<LockIcon aria-hidden="true" />
					)}
					{label}
				</Button>
			)}
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
		</div>
	);
}
