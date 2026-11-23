"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { MicIcon, MicOffIcon, SkipForwardIcon, SquareIcon } from "lucide-react";
import { useState } from "react";
import type { ParlumeSession } from "../lib/parlume-format";
import { SESSIONS_QUERY_KEY } from "../lib/query-keys";

type ParlumeVoiceControl =
	| "stop-speech"
	| "pause"
	| "resume"
	| "continue-reading";

// What a control reports when Parlume had nothing to change.
const UNCHANGED: Partial<Record<ParlumeVoiceControl, string>> = {
	"stop-speech": "Parlume was not speaking.",
	"continue-reading": "No part of a post is waiting to be read.",
};

function sendControl(
	control: ParlumeVoiceControl,
	input: { projectId: string; sessionId: string },
) {
	switch (control) {
		case "stop-speech":
			return orpcClient.projects.parlume.stopSpeech(input);
		case "pause":
			return orpcClient.projects.parlume.pauseListening(input);
		case "resume":
			return orpcClient.projects.parlume.resumeListening(input);
		case "continue-reading":
			return orpcClient.projects.parlume.continueReading(input);
		default: {
			const unreachable: never = control;
			return unreachable;
		}
	}
}

/**
 * Stop Parlume's answer, pause and resume its listening, or have it read the
 * next part of a long post, while it is in the meeting. Anyone who can open
 * the project may use them.
 */
export function ParlumeVoiceControls({
	projectId,
	session,
}: {
	projectId: string;
	session: Pick<ParlumeSession, "id" | "pausedAt" | "pausedBy">;
}) {
	const queryClient = useQueryClient();
	const [pending, setPending] = useState<ParlumeVoiceControl | null>(null);
	const [message, setMessage] = useState<{
		text: string;
		error: boolean;
	} | null>(null);
	const paused = session.pausedAt !== null;

	const run = async (control: ParlumeVoiceControl) => {
		setMessage(null);
		setPending(control);
		try {
			const { changed } = await sendControl(control, {
				projectId,
				sessionId: session.id,
			});
			const unchanged = changed ? undefined : UNCHANGED[control];
			if (unchanged) {
				setMessage({ text: unchanged, error: false });
			}
			await queryClient.invalidateQueries({
				queryKey: [SESSIONS_QUERY_KEY, projectId],
			});
		} catch {
			setMessage({
				text: "Parlume's media bridge did not answer. Try again.",
				error: true,
			});
		} finally {
			setPending(null);
		}
	};

	return (
		<div className="space-y-2 px-6 pb-5">
			<div className="flex flex-wrap gap-2">
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={pending !== null || paused}
					onClick={() => run("stop-speech")}
				>
					<SquareIcon aria-hidden="true" />
					Stop speaking
				</Button>
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={pending !== null || paused}
					onClick={() => run("continue-reading")}
				>
					<SkipForwardIcon aria-hidden="true" />
					Continue reading
				</Button>
				{paused ? (
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={pending !== null}
						onClick={() => run("resume")}
					>
						<MicIcon aria-hidden="true" />
						Resume listening
					</Button>
				) : (
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={pending !== null}
						onClick={() => run("pause")}
					>
						<MicOffIcon aria-hidden="true" />
						Pause listening
					</Button>
				)}
			</div>
			{paused && (
				<p className="text-sm text-muted-foreground">
					Listening paused by {session.pausedBy ?? "a meeting member"}
					. Parlume hears and keeps nothing until you resume it.
				</p>
			)}
			{message && (
				<p
					role={message.error ? "alert" : "status"}
					className={`text-sm ${message.error ? "text-destructive" : "text-muted-foreground"}`}
				>
					{message.text}
				</p>
			)}
		</div>
	);
}
