import { ChatEventReplayError } from "@repo/database";
import { metricsTracker } from "@repo/observability";
import type { ChatExecutionEvent } from "@repo/temporal";
import { QueryNotRegisteredError } from "@repo/temporal/temporal-client-errors";
import type { ChatEventCursor } from "@repo/utils/chat-event-cursor";
import type { OrchestratorStreamInput } from "../orchestrator-stream-protocol";
import {
	ChatReplayAuthorizationError,
	createServerChatReplay,
	projectChatReplayEvent,
} from "./chat-event-replay";
import { ChatRunAccessError, getAuthorizedChatRun } from "./chat-run-control";

export function isFatalChatReplayError(error: unknown): boolean {
	return (
		error instanceof ChatRunAccessError ||
		(error instanceof ChatReplayAuthorizationError &&
			isFatalChatReplayError(error.cause))
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
	let integrity: (() => Promise<void>) | undefined;
	let stopped = false;
	let wakePending = false;
	let wakeTimer: ReturnType<typeof setTimeout> | undefined;
	let lastPoll = 0;
	let forceIntegrity = false;
	let liveOnly = !input.enabled;
	let notice: OrchestratorStreamInput = { type: "replay_unavailable" };
	let delivered: ChatEventCursor | undefined = input.after;
	let pending: ChatExecutionEvent[] = [];
	const forward = (event: ChatExecutionEvent) => {
		if (
			event.eventCursor &&
			delivered &&
			event.eventCursor.runId === delivered.runId &&
			BigInt(event.eventCursor.sequence) <= BigInt(delivered.sequence)
		) {
			return;
		}
		const projected = projectChatReplayEvent(event);
		if (projected && projected.type !== "replay_unavailable") {
			input.send(projected);
		}
	};
	const degrade = () => {
		if (liveOnly) {
			return;
		}
		liveOnly = true;
		clearTimeout(wakeTimer);
		input.send(notice);
		for (const event of pending) {
			forward(event);
		}
		pending = [];
	};
	const failed = (error: unknown) => {
		if (isFatalChatReplayError(error)) {
			throw error;
		}
		degrade();
	};
	const authorize = () =>
		getAuthorizedChatRun({
			executionId: input.executionId,
			userId: input.userId,
			engine: "orchestrator",
			action: "reattach",
			expectedOrganizationId: input.organizationId,
		});
	const wake = () => {
		if (liveOnly || !replay || wakePending || stopped || input.isClosed()) {
			return;
		}
		const delay = 1000 - (Date.now() - lastPoll);
		if (delay > 0) {
			if (!wakeTimer) {
				wakeTimer = setTimeout(() => {
					wakeTimer = undefined;
					wake();
				}, delay);
			}
			return;
		}
		wakePending = true;
		lastPoll = Date.now();
		void replay()
			.catch((error: unknown) => {
				try {
					failed(error);
				} catch (fatal) {
					input.onFailure(fatal);
				}
			})
			.finally(() => {
				wakePending = false;
			});
	};
	return {
		async initialize() {
			if (liveOnly || !input.turnId) {
				if (input.enabled) {
					degrade();
				}
				return null;
			}
			let authorized: Awaited<ReturnType<typeof authorize>>;
			try {
				authorized = await authorize();
			} catch (error) {
				failed(error);
				return null;
			}
			const runId = authorized.description.runId;
			if (!runId) {
				degrade();
				return authorized;
			}
			const handle = authorized.handle;
			integrity = async () => {
				let status: unknown;
				try {
					let timer: ReturnType<typeof setTimeout> | undefined;
					try {
						status = await Promise.race([
							handle.query("chatReplayStatus"),
							new Promise<never>((_, reject) => {
								timer = setTimeout(
									() =>
										reject(
											new ChatEventReplayError(
												"Replay query timed out",
											),
										),
									1000,
								);
							}),
						]);
					} finally {
						clearTimeout(timer);
					}
				} catch (error) {
					if (error instanceof QueryNotRegisteredError) {
						notice = {
							type: "replay_unavailable",
							reason: "query_not_registered",
						};
						throw new ChatEventReplayError(
							"Replay query unavailable",
						);
					}
					throw error;
				}
				forceIntegrity = false;
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
			};
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
						throw new ChatEventReplayError("Replay run changed");
					}
				},
				validateIntegrity: () => integrity?.() ?? Promise.resolve(),
				send: (event) => {
					input.send(event);
					delivered = event.eventCursor ?? delivered;
					pending = pending.filter(
						(entry) =>
							!entry.eventCursor ||
							!delivered ||
							entry.eventCursor.runId !== delivered.runId ||
							BigInt(entry.eventCursor.sequence) >
								BigInt(delivered.sequence),
					);
				},
				isClosed: () => input.isClosed() || stopped || liveOnly,
			});
			return authorized;
		},
		onExecutionEvent(event: ChatExecutionEvent): boolean {
			if (liveOnly) {
				if (
					event.eventCursor &&
					delivered &&
					event.eventCursor.runId === delivered.runId &&
					BigInt(event.eventCursor.sequence) <=
						BigInt(delivered.sequence)
				) {
					return true;
				}
				return false;
			}
			if (!event.eventCursor && !event.replayUnavailable) {
				if (projectChatReplayEvent(event)) {
					degrade();
				}
				return false;
			}
			if (event.event === "execution.limit_signal") {
				metricsTracker.trackAiLimitSignal(
					event.data.kind,
					event.data.provider,
				);
			}
			pending.push(event);
			if (event.replayUnavailable || pending.length >= 200) {
				degrade();
			} else {
				wake();
			}
			return true;
		},
		async beforeState(terminal: boolean) {
			if (liveOnly) {
				return;
			}
			if (terminal || Date.now() - lastPoll >= 1000) {
				forceIntegrity = terminal;
				try {
					await replay?.();
					if (terminal && forceIntegrity) {
						await integrity?.();
					}
				} catch (error) {
					failed(error);
				} finally {
					lastPoll = Date.now();
					forceIntegrity = false;
				}
			}
			if (terminal) {
				clearTimeout(wakeTimer);
				stopped = true;
			}
		},
	};
}
