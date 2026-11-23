"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { Textarea } from "@ui/components/textarea";
import { SendIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import type { ParlumeRequest } from "../lib/parlume-format";
import { CARD_TITLE } from "../lib/parlume-styles";
import { LIVE_ACTIVITY_QUERY_KEY } from "../lib/query-keys";
import { ParlumeRequestItem } from "./ParlumeRequestItem";

/** The procedure's own limit on a page question. */
const MAX_QUESTION_CHARS = 2000;

function errorMessage(error: unknown): string {
	return error instanceof Error && error.message
		? error.message
		: "Parlume could not take the question. Try again.";
}

/**
 * Ask Parlume a question from the Parlume page while it is in the meeting.
 * The answer appears in the requests list on this page only: nothing is said
 * or posted in the meeting, so guests never see it. For project members.
 */
export function ParlumeAskComposer({
	projectId,
	sessionId,
	projectBasePath,
	requests,
}: {
	projectId: string;
	sessionId: string;
	/** `/app/{org}/projects/{id}`, where a proposal is confirmed. */
	projectBasePath: string;
	/** The live session's requests, newest first; its page questions are shown here in full. */
	requests: ParlumeRequest[];
}) {
	const queryClient = useQueryClient();
	const pageRequests = requests.filter(
		(request) => request.replyChannel === "PAGE",
	);
	const [text, setText] = useState("");
	const [pending, setPending] = useState(false);
	const [message, setMessage] = useState<{
		text: string;
		error: boolean;
	} | null>(null);
	const question = text.trim();
	const inputId = `parlume-ask-${sessionId}`;
	const hintId = `${inputId}-hint`;

	const submit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!question || pending) {
			return;
		}
		setMessage(null);
		setPending(true);
		try {
			await orpcClient.projects.parlume.ask({
				projectId,
				sessionId,
				text: question,
			});
			setText("");
			setMessage({
				text: "Asked. The answer appears below.",
				error: false,
			});
			await queryClient.invalidateQueries({
				queryKey: [LIVE_ACTIVITY_QUERY_KEY, projectId],
			});
		} catch (error) {
			setMessage({ text: errorMessage(error), error: true });
		} finally {
			setPending(false);
		}
	};

	return (
		<Card className="p-6">
			<form onSubmit={submit} className="space-y-3">
				<label htmlFor={inputId} className={`block ${CARD_TITLE}`}>
					Ask Parlume here
				</label>
				<p
					id={hintId}
					className="text-[13px] leading-[18px] text-muted-foreground"
				>
					Only this page shows the answer. Nobody in the meeting hears
					or sees it, guests included.
				</p>
				<Textarea
					id={inputId}
					aria-describedby={hintId}
					value={text}
					maxLength={MAX_QUESTION_CHARS}
					rows={3}
					placeholder="What did we decide about the release date?"
					onChange={(event) => setText(event.target.value)}
					disabled={pending}
				/>
				<div className="flex flex-wrap items-center gap-3">
					<Button
						type="submit"
						size="sm"
						disabled={pending || question.length === 0}
					>
						<SendIcon aria-hidden="true" />
						{pending ? "Asking…" : "Ask"}
					</Button>
					{message && (
						<p
							role={message.error ? "alert" : "status"}
							className={`text-sm ${message.error ? "text-destructive" : "text-muted-foreground"}`}
						>
							{message.text}
						</p>
					)}
				</div>
			</form>
			{pageRequests.length > 0 && (
				<ul
					aria-label="Questions asked on this page"
					className="-mx-6 mt-5 -mb-6 border-t border-border [&>li:last-child]:border-b-0"
				>
					{pageRequests.map((request) => (
						<ParlumeRequestItem
							key={request.id}
							request={request}
							projectBasePath={projectBasePath}
						/>
					))}
				</ul>
			)}
		</Card>
	);
}
