import { db, hasProjectAccess } from "@repo/database";
import { logger } from "@repo/logs";
import { Context } from "@temporalio/activity";
import {
	createParlumeToolRuntime,
	type ParlumeActionContext,
} from "./parlume-actions";
import {
	executeParlumeAgent,
	gatherParlumeAgentContext,
	loadParlumeAgent,
} from "./parlume-agent";
import { sendParlumeChatReply } from "./parlume-chat-reply";
import { parlumeActivityLog } from "./parlume-log";
import { createToolNarrator } from "./parlume-narration";
import {
	deliverParlumeRealtimeResult,
	failParlumeRealtimeJob,
} from "./parlume-realtime-result";
import {
	ParlumeSentenceQueue,
	ParlumeSpokenReply,
} from "./parlume-spoken-text";
import { parlumeTurnInstructions } from "./parlume-turn-instructions";
import {
	PARLUME_HEADLINE_SPOKEN_CHARS,
	PARLUME_MAX_SPOKEN_CHARS,
	readParlumeVoiceState,
	requestParlumeMeetingStop,
	speakParlumeResponse,
} from "./parlume-voice";
import {
	formatLiveTranscript,
	formatMeetingChat,
	formatParlumeHistory,
	liveTranscriptStart,
	MAX_LIVE_TRANSCRIPT_SEGMENTS,
	MAX_PARLUME_CHAT_MESSAGES,
	MAX_PARLUME_HISTORY_TURNS,
	PARLUME_PROJECT_PASSAGE_CHARS,
	PARLUME_PROJECT_RAG_CHUNKS,
} from "./parlume-voice-context";
import { retrieveProjectContextsActivity } from "./project-metadata";
import { withAgentToolRuntime } from "./shared/agent-tool-runtime";
import { TurnTimings, withTurnTimings } from "./shared/turn-timing";

export async function failParlumeMeetingTurn(params: {
	turnId: string;
	error: string;
}): Promise<void> {
	const turn = await db.parlumeMeetingTurn.findUnique({
		where: { id: params.turnId },
		select: { sessionId: true },
	});
	if (!turn) {
		return;
	}
	await db.$transaction([
		db.parlumeMeetingTurn.updateMany({
			where: {
				id: params.turnId,
				status: { in: ["PENDING", "RUNNING"] },
			},
			data: {
				status: "FAILED",
				error: params.error,
				completedAt: new Date(),
			},
		}),
		db.parlumeMeetingSession.updateMany({
			where: { id: turn.sessionId, activeTurnId: params.turnId },
			data: { activeTurnId: null },
		}),
		db.parlumeAction.updateMany({
			where: { turnId: params.turnId, status: "EXECUTING" },
			data: {
				status: "OUTCOME_UNKNOWN",
				completedAt: new Date(),
				outcome:
					"Execution stopped before its outcome could be verified. Check the destination before trying again.",
			},
		}),
	]);
}

export async function executeParlumeMeetingTurn(params: {
	turnId: string;
	actingGrant?: string;
	/** The realtime voice's job this turn answers: nothing is spoken here. */
	realtimeJob?: string;
}): Promise<void> {
	const turn = await db.parlumeMeetingTurn.findUnique({
		where: { id: params.turnId },
		include: { session: true },
	});
	if (!turn || turn.status === "COMPLETED" || turn.status === "FAILED") {
		return;
	}
	const { session } = turn;
	const { realtimeJob } = params;
	// The realtime voice that asked is told, so the meeting hears it failed.
	const fail = async (error: string) => {
		await failParlumeMeetingTurn({ turnId: turn.id, error });
		if (realtimeJob) {
			await failParlumeRealtimeJob({
				sessionId: session.id,
				job: realtimeJob,
			});
		}
	};
	if (
		session.status !== "ACTIVE" ||
		turn.voiceGeneration !== session.voiceGeneration
	) {
		await fail("The meeting request is no longer active.");
		return;
	}
	if (
		!(await hasProjectAccess(
			session.projectId,
			session.userId,
			session.organizationId,
		))
	) {
		await fail("The inviter no longer has access to this project.");
		await db.parlumeMeetingSession.updateMany({
			where: { id: session.id, status: "ACTIVE" },
			data: {
				status: "LEAVING",
				leaveRequestedAt: new Date(),
				captureStoppedAt: new Date(),
				lastError: "The inviter no longer has access to this project.",
			},
		});
		try {
			await requestParlumeMeetingStop({ sessionId: session.id });
		} catch {
			logger.error(
				"[Parlume] Could not request a stop after access revocation",
				{ sessionId: session.id },
			);
		}
		return;
	}
	const claimed = await db.parlumeMeetingTurn.updateMany({
		where: { id: turn.id, status: "PENDING" },
		data: { status: "RUNNING", startedAt: new Date(), error: null },
	});
	if (claimed.count === 0) {
		return;
	}
	const startedAt = Date.now();
	const timings = new TurnTimings();
	const queuedMs = startedAt - new Date(turn.createdAt).getTime();
	let firstTextAt: Date | undefined;
	let firstAudioAtMs: number | undefined;
	// One structured line per turn: every step that stands between the end of
	// the question and the first word, in milliseconds, so a slow turn can be
	// read off the log instead of guessed at.
	const logTiming = (outcome: "completed" | "failed" | "agent_failed") => {
		const { values, speech } = timings.snapshot();
		parlumeActivityLog("info", "turn.timing", {
			sessionId: session.id,
			turnId: turn.id,
			voiceGeneration: turn.voiceGeneration,
			outcome,
			agentKind: session.agentKind,
			toolsReadOnly: session.toolsReadOnly,
			queuedMs,
			firstTextMs: firstTextAt ? firstTextAt.getTime() - startedAt : null,
			firstAudioMs: firstAudioAtMs ? firstAudioAtMs - startedAt : null,
			totalMs: Date.now() - startedAt,
			timings: values,
			speech,
		});
	};
	parlumeActivityLog("info", "turn.started", {
		sessionId: session.id,
		turnId: turn.id,
		voiceGeneration: turn.voiceGeneration,
		toolsReadOnly: session.toolsReadOnly,
		agentKind: session.agentKind,
		requestChars: turn.requestText.length,
		queuedMs,
	});
	const liveSpeechAbort = new AbortController();
	let liveSpeech: {
		sentences: ParlumeSentenceQueue;
		playback: ReturnType<typeof speakParlumeResponse>;
	} | null = null;
	// A turn that fails must not leave a reply half spoken or its stream open.
	const stopLiveSpeech = () => {
		liveSpeech?.sentences.end();
		liveSpeechAbort.abort();
	};
	try {
		const agent = await timings.time("agentLoadMs", () =>
			loadParlumeAgent(session),
		);
		// Runs alongside the meeting context gathered below.
		const gathered =
			agent.kind === "FABRIC_AGENT"
				? withTurnTimings(timings, () =>
						gatherParlumeAgentContext(
							agent,
							session,
							turn.requestText,
						),
					)
				: undefined;
		const actionContext: ParlumeActionContext = {
			turnId: turn.id,
			sessionId: session.id,
			projectId: session.projectId,
			organizationId: session.organizationId,
			userId: session.userId,
			speakerId: turn.speakerId,
			speakerName: turn.speakerName,
			requestText: turn.requestText,
			agentRevision: agent.revision,
			voiceGeneration: turn.voiceGeneration,
			toolsReadOnly: session.toolsReadOnly,
			signal: Context.current().cancellationSignal,
		};
		await timings.time("agentRevisionWriteMs", () =>
			db.parlumeMeetingTurn.update({
				where: { id: turn.id },
				data: { agentRevision: agent.revision },
			}),
		);
		const signal = Context.current().cancellationSignal;
		const speaker = {
			sessionId: session.id,
			userId: session.userId,
			organizationId: session.organizationId,
			projectId: session.projectId,
			voiceGeneration: turn.voiceGeneration,
			signal,
		};
		// A request typed in the meeting chat is answered there, and one from
		// the realtime voice is spoken by that voice: neither is spoken here.
		const unspoken =
			turn.replyChannel === "CHAT" || realtimeJob !== undefined;
		// The answer's headline is spoken while the agent is still writing it;
		// its detail, and anything past the headline's length, goes to the chat.
		const liveSentences = new ParlumeSentenceQueue(
			PARLUME_HEADLINE_SPOKEN_CHARS,
		);
		const spokenReply = new ParlumeSpokenReply(liveSentences);
		// Someone spoke over the reply: it is no longer heard, and its tools
		// are no longer narrated.
		let muted = false;
		const livePlayback = unspoken
			? null
			: withTurnTimings(timings, () =>
					speakParlumeResponse({
						...speaker,
						signal: AbortSignal.any([
							signal,
							liveSpeechAbort.signal,
						]),
						sentences: liveSentences,
					}),
				);
		if (livePlayback) {
			// Awaited below once the answer is complete.
			livePlayback.then(
				(playback) => {
					muted = playback.muted === true;
				},
				() => {},
			);
			liveSpeech = { sentences: liveSentences, playback: livePlayback };
		}
		// Asked alongside the context below. A chat out of Parlume's reach
		// cannot take the detail, so the reply speaks it, at more length.
		const chatReachable = unspoken
			? Promise.resolve(true)
			: readParlumeVoiceState(speaker).then(({ chatAvailable }) => {
					if (!chatAvailable) {
						spokenReply.speakEverything(PARLUME_MAX_SPOKEN_CHARS);
					}
					return chatAvailable;
				});
		const [projectRag, segments, chatMessages, previous] =
			await timings.time("contextGatherMs", () =>
				Promise.all([
					timings.time("projectRagMs", () =>
						retrieveProjectContextsActivity(
							turn.requestText,
							session.projectId,
							session.userId,
							session.organizationId,
							PARLUME_PROJECT_RAG_CHUNKS,
							{ maxPassageChars: PARLUME_PROJECT_PASSAGE_CHARS },
						),
					),
					timings.time("segmentsQueryMs", () =>
						db.parlumeMeetingSegment.findMany({
							where: {
								sessionId: session.id,
								source: "SPEECH",
								createdAt: {
									gte: liveTranscriptStart(Date.now()),
								},
							},
							select: { text: true, speakerName: true },
							orderBy: { createdAt: "desc" },
							take: MAX_LIVE_TRANSCRIPT_SEGMENTS,
						}),
					),
					timings.time("chatQueryMs", () =>
						db.parlumeMeetingSegment.findMany({
							where: { sessionId: session.id, source: "CHAT" },
							select: { text: true, speakerName: true },
							orderBy: { createdAt: "desc" },
							take: MAX_PARLUME_CHAT_MESSAGES,
						}),
					),
					timings.time("historyQueryMs", () =>
						db.parlumeMeetingTurn.findMany({
							where: {
								sessionId: session.id,
								status: "COMPLETED",
								id: { not: turn.id },
							},
							select: {
								requestText: true,
								responseText: true,
							},
							orderBy: { completedAt: "desc" },
							take: MAX_PARLUME_HISTORY_TURNS,
						}),
					),
				]),
			);
		const history = formatParlumeHistory(previous);
		const transcript = formatLiveTranscript(segments);
		const chat = formatMeetingChat(chatMessages);
		const voiceInstructions = parlumeTurnInstructions({
			replyChannel: realtimeJob ? "REALTIME" : turn.replyChannel,
			toolsReadOnly: session.toolsReadOnly,
		});
		const result = await timings.time("agentRunMs", () =>
			withTurnTimings(timings, () =>
				withAgentToolRuntime(
					{
						...createParlumeToolRuntime(actionContext),
						onText: (text) => {
							firstTextAt ??= new Date();
							if (liveSpeech) {
								spokenReply.push(text);
							}
						},
						onToolStart: unspoken
							? undefined
							: createToolNarrator(liveSentences, () => muted),
					},
					() =>
						executeParlumeAgent({
							agent,
							session,
							turnId: turn.id,
							message: turn.requestText,
							voiceInstructions,
							knowledgeContext: [
								projectRag?.context,
								chat ? `Recent meeting chat:\n${chat}` : null,
								transcript
									? `Recent meeting transcript:\n${transcript}`
									: null,
							]
								.filter(Boolean)
								.join("\n\n"),
							history,
							gathered,
							actingGrant: params.actingGrant,
						}),
				),
			),
		);
		if (!result.success) {
			stopLiveSpeech();
			logTiming("agent_failed");
			await fail(result.error || "Parlume agent execution failed.");
			return;
		}
		const response = result.response;
		// An engine that returned the answer without streaming it is
		// spoken whole.
		if (!spokenReply.received) {
			spokenReply.push(response);
		}
		const chatAvailable = await chatReachable;
		spokenReply.end();
		await db.parlumeMeetingTurn.update({
			where: { id: turn.id },
			data: {
				responseText: response,
				firstTextAt: firstTextAt ?? new Date(),
			},
		});
		if (realtimeJob) {
			// Completed first: the voice may ask Fabric again as soon as it
			// hears this answer, and only one turn runs at a time.
			await db.$transaction([
				db.parlumeMeetingTurn.updateMany({
					where: { id: turn.id, status: "RUNNING" },
					data: { status: "COMPLETED", completedAt: new Date() },
				}),
				db.parlumeMeetingSession.updateMany({
					where: { id: session.id, activeTurnId: turn.id },
					data: { activeTurnId: null },
				}),
			]);
			const delivery = await deliverParlumeRealtimeResult({
				sessionId: session.id,
				turnId: turn.id,
				voiceGeneration: turn.voiceGeneration,
				job: realtimeJob,
				text: response,
			});
			if (delivery.note) {
				await db.parlumeMeetingTurn.updateMany({
					where: { id: turn.id, status: "COMPLETED" },
					data: { error: delivery.note },
				});
			}
			logTiming("completed");
			parlumeActivityLog(
				delivery.note ? "warn" : "info",
				"turn.completed",
				{
					sessionId: session.id,
					turnId: turn.id,
					voiceGeneration: turn.voiceGeneration,
					delivery: "realtime",
					job: realtimeJob,
					spoken: delivery.spoken,
					chatPosts: delivery.chat?.tags.length ?? 0,
					responseChars: response.length,
					totalMs: Date.now() - startedAt,
				},
			);
			return;
		}
		if (!livePlayback) {
			const delivery = await sendParlumeChatReply({
				sessionId: session.id,
				turnId: turn.id,
				voiceGeneration: turn.voiceGeneration,
				text: response,
			});
			await db.$transaction([
				db.parlumeMeetingTurn.updateMany({
					where: { id: turn.id, status: "RUNNING" },
					data: {
						status: "COMPLETED",
						completedAt: new Date(),
						...(delivery.sent
							? {}
							: {
									error:
										delivery.reason === "chat_unavailable"
											? "The answer was not sent: this meeting's chat is unavailable to Parlume."
											: "The answer could not be sent to the meeting chat.",
								}),
					},
				}),
				db.parlumeMeetingSession.updateMany({
					where: { id: session.id, activeTurnId: turn.id },
					data: { activeTurnId: null },
				}),
			]);
			logTiming("completed");
			parlumeActivityLog(
				delivery.sent ? "info" : "warn",
				"turn.completed",
				{
					sessionId: session.id,
					turnId: turn.id,
					voiceGeneration: turn.voiceGeneration,
					replyChannel: "CHAT",
					sentToChat: delivery.sent,
					chatPosts: delivery.tags.length,
					responseChars: response.length,
					firstTextMs: firstTextAt
						? firstTextAt.getTime() - startedAt
						: null,
					totalMs: Date.now() - startedAt,
				},
			);
			return;
		}
		let playback: Awaited<ReturnType<typeof speakParlumeResponse>>;
		let deliveryNote: string | null = null;
		try {
			playback = await livePlayback;
		} catch (speechError) {
			if (signal.aborted) {
				throw speechError;
			}
			// The answer exists; only the voice failed. Deliver it as text so
			// the question is still answered, and say so in the history.
			const reason =
				speechError instanceof Error
					? speechError.message
					: String(speechError);
			const delivery = await sendParlumeChatReply({
				sessionId: session.id,
				turnId: turn.id,
				voiceGeneration: turn.voiceGeneration,
				text: response,
			});
			parlumeActivityLog(
				delivery.sent ? "warn" : "error",
				"turn.speech_failed",
				{
					sessionId: session.id,
					turnId: turn.id,
					voiceGeneration: turn.voiceGeneration,
					sentToChat: delivery.sent,
					delivery: delivery.sent ? "queued" : null,
					error: reason.slice(0, 300),
				},
			);
			if (!delivery.sent) {
				throw speechError;
			}
			playback = { played: false, interrupted: false };
			deliveryNote = `Spoken reply unavailable (${reason.slice(0, 160)}); the answer was sent to the meeting chat as ${delivery.tags.join(", ")}.`;
		}
		// What the meeting did not hear goes to its chat as one post: the
		// detail and anything past the headline's length, or, when someone
		// spoke over the reply, all of the answer they missed.
		const rest =
			deliveryNote !== null
				? ""
				: playback.muted
					? spokenReply.unheardText(playback.heard ?? 0)
					: chatAvailable
						? spokenReply.chatText
						: "";
		const restDelivery = rest
			? await sendParlumeChatReply({
					sessionId: session.id,
					turnId: turn.id,
					voiceGeneration: turn.voiceGeneration,
					text: rest,
				})
			: null;
		const restNote =
			!restDelivery || restDelivery.sent
				? null
				: restDelivery.reason === "chat_unavailable"
					? "The rest of the answer was not sent: this meeting's chat is unavailable to Parlume."
					: "The rest of the answer could not be sent to the meeting chat.";
		const note = deliveryNote ?? restNote;
		await db.$transaction([
			db.parlumeMeetingTurn.updateMany({
				where: { id: turn.id, status: "RUNNING" },
				data: {
					status: "COMPLETED",
					completedAt: new Date(),
					// A chat delivery report may already have noted this turn.
					...(note ? { error: note } : {}),
					firstAudioAt: playback.firstAudioAt
						? new Date(playback.firstAudioAt)
						: null,
					spokenAt: playback.played ? new Date() : null,
					interruptedAt: playback.interrupted ? new Date() : null,
				},
			}),
			db.parlumeMeetingSession.updateMany({
				where: { id: session.id, activeTurnId: turn.id },
				data: { activeTurnId: null },
			}),
		]);
		firstAudioAtMs = playback.firstAudioAt;
		logTiming("completed");
		parlumeActivityLog("info", "turn.completed", {
			sessionId: session.id,
			turnId: turn.id,
			voiceGeneration: turn.voiceGeneration,
			played: playback.played,
			interrupted: playback.interrupted,
			muted: playback.muted === true,
			replyChannel: "VOICE",
			sentToChat: deliveryNote !== null,
			restChars: rest.length,
			restPosts: restDelivery?.tags.length ?? 0,
			restSent: restDelivery?.sent ?? null,
			responseChars: response.length,
			firstTextMs: firstTextAt ? firstTextAt.getTime() - startedAt : null,
			firstAudioMs: playback.firstAudioAt
				? playback.firstAudioAt - startedAt
				: null,
			totalMs: Date.now() - startedAt,
		});
	} catch (error) {
		stopLiveSpeech();
		logTiming("failed");
		parlumeActivityLog("error", "turn.failed", {
			sessionId: session.id,
			turnId: turn.id,
			voiceGeneration: turn.voiceGeneration,
			totalMs: Date.now() - startedAt,
			error:
				error instanceof Error
					? `${error.name}: ${error.message}`.slice(0, 300)
					: "Unknown error",
		});
		await fail("Parlume agent execution failed.");
	}
}
