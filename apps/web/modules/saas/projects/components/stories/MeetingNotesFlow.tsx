"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { validateBacklogAnalysisSources } from "../../lib/backlog-analysis-sources";
import { MeetingSelector } from "./MeetingSelector";

type Meetings = ReturnType<
	typeof validateBacklogAnalysisSources
>["selectedMeetings"];
export const MEETING_NOTES_SKIPPED_NONE_RESULT =
	"No meetings were selected. Do not fetch meeting notes.";
export const MEETING_NOTES_SKIPPED_TOO_MANY_RESULT =
	"At most 10 meetings can be fetched at once. Ask the user to pick fewer meetings.";

export const MEETING_NOTES_TRANSCRIPT_MARKER = "MEETING TRANSCRIPTS";

export function isMeetingNotesTranscriptResult(
	result: unknown,
): result is string {
	return (
		typeof result === "string" &&
		result.startsWith(
			`${MEETING_NOTES_TRANSCRIPT_MARKER} (reference material`,
		)
	);
}

/** Own selector admission and transcript fetching; document authoring remains an agent operation. */
export class MeetingNotesFlow {
	private admitted = new Set<string>();
	private listeners = new Set<() => void>();
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	snapshot = () => this.active;
	private publish() {
		if (this.active) {
			this.active = { ...this.active };
		}
		for (const listener of this.listeners) {
			listener();
		}
	}

	private active?: {
		flowId: string;
		messageId: string;
		phase: "selecting" | "fetching" | "done";
		result?: Promise<string>;
	};
	admit(messageId?: string) {
		if (messageId && this.active?.messageId === messageId) {
			return this.active.flowId;
		}
		if (!messageId || this.admitted.has(messageId)) {
			return undefined;
		}
		this.admitted.add(messageId);
		const flowId = crypto.randomUUID();
		this.active = { flowId, messageId, phase: "selecting" };
		this.publish();
		return flowId;
	}
	confirm(
		flowId: string,
		input: unknown,
		fetch: (meetings: Meetings) => Promise<string>,
	): Promise<string> {
		const flow = this.active;
		if (!flow || flow.flowId !== flowId || flow.phase !== "selecting") {
			return Promise.resolve(
				"This meeting selection is stale or already completed.",
			);
		}
		flow.phase = "fetching";
		const { selectedMeetings } = validateBacklogAnalysisSources({
			selectedMeetings: input,
		});
		// Defer invocation until result is assigned, so synchronous re-entry cannot fetch twice.
		flow.result = Promise.resolve().then(async () => {
			if (this.active?.flowId !== flow.flowId) {
				return "This meeting request was superseded.";
			}
			try {
				if (!selectedMeetings.length) {
					return MEETING_NOTES_SKIPPED_NONE_RESULT;
				}
				if (selectedMeetings.length > 10) {
					return MEETING_NOTES_SKIPPED_TOO_MANY_RESULT;
				}
				const result = await fetch(selectedMeetings);
				return this.active?.flowId === flow.flowId
					? result
					: "This meeting request was superseded.";
			} catch (error) {
				return `Error: ${error instanceof Error ? error.message : "Failed to fetch meeting notes"}`;
			} finally {
				if (this.active?.flowId === flow.flowId) {
					this.active.phase = "done";
					this.publish();
				}
			}
		});
		this.publish();
		return flow.result;
	}
	result(messageId?: string) {
		return messageId &&
			this.active?.messageId === messageId &&
			this.active.result
			? this.active.result
			: Promise.resolve(
					"Confirm a meeting selection in the existing card. No notes were fetched.",
				);
	}
}

export function MeetingNotesFlowCard({
	controller,
	messageId,
	status = "executing",
	result: completedResult,
	projectId,
	organizationId,
	fetchNotes,
	respond,
}: {
	controller: MeetingNotesFlow;
	messageId?: string;
	status?: "inProgress" | "executing" | "complete";
	result?: string;
	projectId: string;
	organizationId: string | null;
	fetchNotes: (meetings: Meetings) => Promise<string>;
	respond?: (result: string) => void;
}) {
	const flow = useSyncExternalStore(
		controller.subscribe,
		controller.snapshot,
		controller.snapshot,
	);
	const [flowId, setFlowId] = useState<string>();
	const [result, setResult] = useState<string>();
	useEffect(() => {
		setResult(undefined);
		if (status !== "executing" || !respond) {
			setFlowId(undefined);
			return;
		}
		const admitted = controller.admit(messageId);
		setFlowId(admitted);
		// A message may arrive after the tool's first render; leave admission retryable.
	}, [controller, messageId, status, respond]);
	useEffect(() => {
		let attached = true;
		if (
			status === "executing" &&
			respond &&
			flowId &&
			flow?.flowId === flowId &&
			flow.result
		) {
			void flow.result.then((value) => {
				if (attached) {
					setResult(value);
					respond?.(value);
				}
			});
		}
		return () => {
			attached = false;
		};
	}, [flowId, flow?.flowId, flow?.result, respond, status]);
	const displayedResult =
		status === "complete" ? (completedResult ?? result) : result;
	if (status === "complete" || displayedResult !== undefined) {
		const message =
			displayedResult === MEETING_NOTES_SKIPPED_NONE_RESULT
				? "No meetings were selected. Meeting notes were not fetched."
				: displayedResult === MEETING_NOTES_SKIPPED_TOO_MANY_RESULT
					? "Meeting notes were not fetched. Select at most 10 meetings."
					: displayedResult?.startsWith("Error:")
						? "Failed to fetch meeting notes."
						: isMeetingNotesTranscriptResult(displayedResult)
							? "Meeting notes fetched successfully."
							: "No meeting notes were fetched.";
		return (
			<output className="block rounded-lg border p-3 text-sm">
				{message}
			</output>
		);
	}

	if (!flowId || flow?.flowId !== flowId) {
		return (
			<p className="text-sm text-muted-foreground">
				Waiting for a genuine user request.
			</p>
		);
	}
	if (flow.phase !== "selecting") {
		return (
			<output className="block rounded-lg border p-3 text-sm">
				Fetching meeting notes...
			</output>
		);
	}
	return (
		<MeetingSelector
			projectId={projectId}
			organizationId={organizationId}
			onConfirm={(meetings) => {
				void controller.confirm(flowId, meetings, fetchNotes);
			}}
			onCancel={() => {
				void controller.confirm(flowId, [], fetchNotes);
			}}
		/>
	);
}
