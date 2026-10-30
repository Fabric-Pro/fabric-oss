import { ChatEventReplayError } from "@repo/database";
import { metricsTracker } from "@repo/observability";
import type { ChatExecutionEvent } from "@repo/temporal";
import type { ChatEventCursor } from "@repo/utils/chat-event-cursor";
import type { OrchestratorStreamInput } from "../orchestrator-stream-protocol";
import {
	ChatReplayAuthorizationError,
	createServerChatReplay,
} from "./chat-event-replay";
import { ChatRunAccessError, getAuthorizedChatRun } from "./chat-run-control";

export function isFatalChatReplayError(error: unknown): boolean {
	return (
		error instanceof ChatRunAccessError ||
		error instanceof ChatEventReplayError ||
		(error instanceof ChatReplayAuthorizationError &&
			error.cause instanceof ChatRunAccessError)
	);
}

/** Replay transport for one response; workflow execution and status polling stay separate. */
export function createChatReplayObserver(input: {
	enabled: boolean;
	turnId?: string;
	executionId: string;
	organizationId: string;
	userId: string;
	after?: ChatEventCursor;
	send: (event: OrchestratorStreamInput) => void;
	isClosed: () => boolean;
	onFailure: (error: unknown) => void;
}) {
	let replay: (() => Promise<void>) | undefined;
	let stopped = false;
	let wakePending = false;
	let lastPoll = 0;
	const authorize = () =>
		getAuthorizedChatRun({
			executionId: input.executionId,
			userId: input.userId,
			engine: "orchestrator",
			action: "reattach",
			expectedOrganizationId: input.organizationId,
		});
	const wake = () => {
		if (!replay || wakePending || stopped || input.isClosed()) {
			return;
		}
		wakePending = true;
		void replay()
			.catch((error: unknown) => {
				if (isFatalChatReplayError(error)) {
					input.onFailure(error);
				}
			})
			.finally(() => {
				wakePending = false;
			});
	};
	return {
		async initialize() {
			if (!input.enabled || !input.turnId) {
				if (input.after) {
					throw new ChatEventReplayError("The run has no replay log");
				}
				return null;
			}
			const authorized = await authorize();
			const runId = authorized.description.runId;
			if (!runId) {
				throw new ChatEventReplayError(
					"The run cannot provide replay context",
				);
			}
			const handle = authorized.handle;
			replay = createServerChatReplay({
				scope: {
					turnId: input.turnId,
					executionId: input.executionId,
					organizationId: input.organizationId,
					userId: input.userId,
					runId,
				},
				after: input.after,
				authorize: async () => {
					if ((await authorize()).description.runId !== runId) {
						throw new ChatRunAccessError();
					}
				},
				validateIntegrity: async () => {
					// The history-derived flag is read after the journal rows, so a later
					// producer cannot conceal an earlier activity's journal failure.
					let status: unknown;
					try {
						status = await handle.query("chatReplayStatus");
					} catch (error) {
						if (
							error instanceof Error &&
							/query.*(not registered|not found|expected to be registered|unknown)|no query handler/i.test(
								error.message,
							)
						) {
							throw new ChatEventReplayError(
								"This run cannot safely replay output. Refresh to check its final result.",
							);
						}
						throw error;
					}
					if (
						!status ||
						typeof status !== "object" ||
						!("version" in status) ||
						status.version !== 1 ||
						!("unavailable" in status) ||
						status.unavailable !== false
					) {
						throw new ChatEventReplayError(
							"Replay output is incomplete. Refresh to check the run's final result.",
						);
					}
				},
				send: input.send,
				isClosed: () => input.isClosed() || stopped,
			});
			return authorized;
		},
		onExecutionEvent(event: ChatExecutionEvent): boolean {
			if (
				!input.enabled ||
				(!event.eventCursor && !event.replayUnavailable)
			) {
				return false;
			}
			if (event.event === "execution.limit_signal") {
				metricsTracker.trackAiLimitSignal(
					event.data.kind,
					event.data.provider,
				);
			}
			if (event.replayUnavailable) {
				input.onFailure(
					new ChatEventReplayError(
						"Live replay is unavailable. Your partial reply has been kept; the workflow may still be running.",
					),
				);
			} else {
				wake();
			}
			return true;
		},
		async beforeState(terminal: boolean) {
			if (terminal) {
				try {
					await replay?.();
				} catch (error) {
					if (
						error instanceof ChatRunAccessError ||
						error instanceof ChatReplayAuthorizationError
					) {
						throw error;
					}
					// The authorized terminal result remains authoritative if its cache expired or has gaps.
				}
				stopped = true;
			} else if (Date.now() - lastPoll >= 1000) {
				await replay?.();
				lastPoll = Date.now();
			}
		},
	};
}
