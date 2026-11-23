"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Volume2Icon, XIcon } from "lucide-react";
import { useState } from "react";
import { SUGGESTIONS_QUERY_KEY } from "../lib/query-keys";

type SuggestionControl = "say" | "dismiss";

function errorMessage(error: unknown): string {
	return error instanceof Error && error.message
		? error.message
		: "Parlume's media bridge did not answer. Try again.";
}

/**
 * Say in meeting and Dismiss for one live suggestion, for project members.
 * Say in meeting is off while a guest is or was expected in the meeting:
 * what the team keeps to itself is never said in front of one.
 */
export function ParlumeSuggestionActions({
	projectId,
	sessionId,
	suggestionId,
	guestsPresent,
}: {
	projectId: string;
	sessionId: string;
	suggestionId: string;
	guestsPresent: boolean;
}) {
	const queryClient = useQueryClient();
	const [pending, setPending] = useState<SuggestionControl | null>(null);
	const [message, setMessage] = useState<{
		text: string;
		error: boolean;
	} | null>(null);
	const input = { projectId, sessionId, suggestionId };
	const hintId = `parlume-suggestion-${suggestionId}-guests`;

	const run = async (control: SuggestionControl) => {
		setMessage(null);
		setPending(control);
		try {
			switch (control) {
				case "say": {
					const { spoken } =
						await orpcClient.projects.parlume.saySuggestion(input);
					setMessage(
						spoken
							? {
									text: "Parlume is saying it in the meeting.",
									error: false,
								}
							: {
									text: "Parlume did not say it: it is paused or a guest is in the meeting.",
									error: false,
								},
					);
					break;
				}
				case "dismiss":
					await orpcClient.projects.parlume.dismissSuggestion(input);
					await queryClient.invalidateQueries({
						queryKey: [SUGGESTIONS_QUERY_KEY, projectId, sessionId],
					});
					break;
				default: {
					const unreachable: never = control;
					return unreachable;
				}
			}
		} catch (error) {
			setMessage({ text: errorMessage(error), error: true });
		} finally {
			setPending(null);
		}
	};

	return (
		<div className="space-y-1.5 pt-1">
			<div className="flex flex-wrap gap-2">
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={pending !== null || guestsPresent}
					aria-describedby={guestsPresent ? hintId : undefined}
					onClick={() => run("say")}
				>
					<Volume2Icon aria-hidden="true" />
					Say in meeting
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					disabled={pending !== null}
					onClick={() => run("dismiss")}
				>
					<XIcon aria-hidden="true" />
					Dismiss
				</Button>
			</div>
			{guestsPresent && (
				<p id={hintId} className="text-xs text-muted-foreground">
					A guest is in this meeting, so Parlume says nothing from
					this page.
				</p>
			)}
			{message && (
				<p
					role={message.error ? "alert" : "status"}
					className={`text-xs ${message.error ? "text-destructive" : "text-muted-foreground"}`}
				>
					{message.text}
				</p>
			)}
		</div>
	);
}
