import { buildParlumePageUrl, db, hasProjectAccess } from "@repo/database";
import { logger } from "@repo/logs";
import { PARLUME_UNCONFIRMED_REQUESTER_REPLY } from "@repo/utils/parlume-confidential";
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
import {
	finishParlumeChatReply,
	onlyNotesParlumeProposal,
	parlumeChatNotSentNote,
	sendParlumeChatReply,
} from "./parlume-chat-reply";
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
import { recordParlumeTurnAnswered } from "./parlume-turn-audit";
import {
	parlumeFixedTurnReply,
	parlumeTurnInstructions,
} from "./parlume-turn-instructions";
import {
	PARLUME_HEADLINE_SPOKEN_CHARS,
	PARLUME_MAX_SPOKEN_CHARS,
	type ParlumeChatPostHeader,
	postParlumeMeetingChat,
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

// Well inside the meeting-turn workflow's heartbeat timeout.
const PARLUME_TURN_HEARTBEAT_MS = 1_000;

/** Why a request failed, as the meeting chat is told. */
type ParlumeTurnFailureReason = "failed" | "timed_out";

/** The plain reason an error post gives: never the internal error. */
function turnFailureText(reason: ParlumeTurnFailureReason): string {
	switch (reason) {
		case "failed":
			return "I could not finish the answer.";
		case "timed_out":
			return "The answer took too long.";
		default: {
			const unreachable: never = reason;
			return unreachable;
		}
	}
}

export async function failParlumeMeetingTurn(params: {
	turnId: string;
	error: string;
	/** The tools the turn called before it failed, for its audit row. */
	toolNames?: string[];
	/**
	 * Why the request failed, for an error post in the meeting chat. Absent
	 * when the chat is not told: a request no longer wanted, an inviter who
	 * lost access (Parlume leaves), a turn someone stopped, or a realtime
	 * job, whose voice says that it failed.
	 */
	chatReason?: ParlumeTurnFailureReason;
}): Promise<void> {
	const turn = await db.parlumeMeetingTurn.findUnique({
		where: { id: params.turnId },
		select: {
			id: true,
			sessionId: true,
			projectId: true,
			organizationId: true,
			speakerName: true,
			requestText: true,
			voiceGeneration: true,
		},
	});
	if (!turn) {
		return;
	}
	const [failed] = await db.$transaction([
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
	]);
	if (failed.count > 0) {
		await recordParlumeTurnAnswered({
			turnId: params.turnId,
			status: "FAILED",
			toolNames: params.toolNames,
		});
		// Only this write ended the turn: one someone stopped, or that
		// ended otherwise first, stays quiet.
		if (params.chatReason) {
			await postParlumeTurnFailure(turn, params.chatReason);
		}
	}
}

/**
 * The error post: who asked and what, the plain reason and the Parlume page,
 * never the internal error. Marked final, so a typed request's lane is free
 * at once. The failure is recorded already, so a post that cannot be made
 * is logged and changes nothing.
 */
async function postParlumeTurnFailure(
	turn: {
		id: string;
		sessionId: string;
		projectId: string;
		organizationId: string;
		speakerName: string | null;
		requestText: string;
		voiceGeneration: number;
	},
	reason: ParlumeTurnFailureReason,
): Promise<void> {
	try {
		const pageUrl = await buildParlumePageUrl(turn);
		const posted = await postParlumeMeetingChat({
			sessionId: turn.sessionId,
			turnId: turn.id,
			voiceGeneration: turn.voiceGeneration,
			final: true,
			message: `${turnFailureText(reason)} Ask again in a minute.\n[Parlume page](${pageUrl})`,
			header: {
				kind: "error",
				asker: turn.speakerName,
				request: turn.requestText,
			},
		});
		parlumeActivityLog(
			posted.sent ? "info" : "warn",
			"turn.failure_posted",
			{
				sessionId: turn.sessionId,
				turnId: turn.id,
				sent: posted.sent,
				...(posted.sent
					? { tag: posted.tag }
					: { reason: posted.reason }),
			},
		);
	} catch (error) {
		parlumeActivityLog("warn", "turn.failure_post_failed", {
			sessionId: turn.sessionId,
			turnId: turn.id,
			error:
				error instanceof Error
					? `${error.name}: ${error.message}`.slice(0, 300)
					: "Unknown error",
		});
	}
}

type ParlumeMeetingTurnParams = {
	turnId: string;
	/** Minted for the confirmed participant who asked; none when nobody was placed. */
	actingGrant?: string;
	/** The realtime voice's job this turn answers: nothing is spoken here. */
	realtimeJob?: string;
	/**
	 * Everyone present is one of the meeting's verified attendees, so the turn
	 * may use what the meeting said in its confidential part. Absent from a
	 * web route that predates it, which counts as no.
	 */
	withConfidential?: boolean;
};

/**
 * Temporal delivers a cancellation only with a heartbeat, so the turn beats
 * from its first step to its last: a turn someone stopped or paused ends
 * within one, wherever it is waiting.
 */
export async function executeParlumeMeetingTurn(
	params: ParlumeMeetingTurnParams,
): Promise<void> {
	const activity = Context.current();
	const heartbeat = setInterval(
		() => activity.heartbeat(),
		PARLUME_TURN_HEARTBEAT_MS,
	);
	try {
		await runParlumeMeetingTurn(params, activity.cancellationSignal);
	} finally {
		clearInterval(heartbeat);
	}
}

async function runParlumeMeetingTurn(
	params: ParlumeMeetingTurnParams,
	signal: AbortSignal,
): Promise<void> {
	const turn = await db.parlumeMeetingTurn.findUnique({
		where: { id: params.turnId },
		include: { session: true },
	});
	if (
		!turn ||
		turn.status === "COMPLETED" ||
		turn.status === "FAILED" ||
		turn.status === "STOPPED"
	) {
		return;
	}
	const { session } = turn;
	const { realtimeJob } = params;
	// Asked on the Parlume page and answered only there: it takes no turn of
	// the voice, so the voice moving on does not end it.
	const pageOnly = turn.replyChannel === "PAGE";
	// The first lines of the turn's chat posts: what each is, and who asked.
	const postHeader = (kind: "answer" | "detail"): ParlumeChatPostHeader => ({
		kind,
		asker: turn.speakerName,
		request: turn.requestText,
	});
	// The tools the turn called, by name, for its audit row.
	const toolNames = new Set<string>();
	// One audit row per turn, from the write that ended it.
	const auditCompleted = async (completed: { count: number }) => {
		if (completed.count > 0) {
			await recordParlumeTurnAnswered({
				turnId: turn.id,
				status: "COMPLETED",
				toolNames: [...toolNames],
			});
		}
	};
	// The realtime voice that asked is told, so the meeting hears it failed;
	// for any other request the chat is told, unless someone stopped it.
	const fail = async (
		error: string,
		chatReason?: ParlumeTurnFailureReason,
	) => {
		await failParlumeMeetingTurn({
			turnId: turn.id,
			error,
			toolNames: [...toolNames],
			chatReason: realtimeJob || signal.aborted ? undefined : chatReason,
		});
		if (realtimeJob) {
			await failParlumeRealtimeJob({
				sessionId: session.id,
				job: realtimeJob,
			});
		}
	};
	if (
		session.status !== "ACTIVE" ||
		(!pageOnly && turn.voiceGeneration !== session.voiceGeneration)
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
	// Every lookup runs with the asker's project access, checked again here.
	// An asker Fabric could not place, or who can no longer read the project,
	// gets a fixed answer and nothing is looked up.
	const requesterUserId =
		turn.requesterUserId &&
		(await hasProjectAccess(
			session.projectId,
			turn.requesterUserId,
			session.organizationId,
		))
			? turn.requesterUserId
			: null;
	const fixedReply = parlumeFixedTurnReply({
		requestText: turn.requestText,
		requesterUserId,
		confidentialOpen: session.confidentialSince !== null,
	});
	// The meeting's confidential part, and the answers given about it, only
	// while everyone present is one of its verified attendees.
	const withConfidential =
		params.withConfidential === true || !session.confidential;
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
			agent.kind === "FABRIC_AGENT" &&
			fixedReply === null &&
			requesterUserId !== null
				? withTurnTimings(timings, () =>
						gatherParlumeAgentContext(
							agent,
							session,
							turn.requestText,
							requesterUserId,
						),
					)
				: undefined;
		const proposalTags: string[] = [];
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
			signal,
			proposalTags,
			pageOnly,
		};
		await timings.time("agentRevisionWriteMs", () =>
			db.parlumeMeetingTurn.update({
				where: { id: turn.id },
				data: { agentRevision: agent.revision },
			}),
		);
		const speaker = {
			sessionId: session.id,
			userId: session.userId,
			organizationId: session.organizationId,
			projectId: session.projectId,
			voiceGeneration: turn.voiceGeneration,
			signal,
		};
		// A request typed in the meeting chat is answered there, one asked on
		// the Parlume page stays there, and one from the realtime voice is
		// spoken by that voice: none is spoken here.
		const unspoken =
			turn.replyChannel === "CHAT" ||
			pageOnly ||
			realtimeJob !== undefined;
		// The answer's headline is spoken while the agent is still writing it;
		// its detail, and anything past the headline's length, goes to the chat.
		const liveSentences = new ParlumeSentenceQueue(
			PARLUME_HEADLINE_SPOKEN_CHARS,
		);
		const spokenReply = new ParlumeSpokenReply(liveSentences);
		const narrateTool = unspoken
			? undefined
			: createToolNarrator(liveSentences);
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
			livePlayback.catch(() => {});
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
		// The agent's run, as the confirmed participant who asked: the
		// project's passages are searched with their access, and the
		// confidential part of the meeting is left out unless everyone
		// present may hear it.
		const answerAs = async (askerId: string) => {
			const confidentialFilter = withConfidential
				? {}
				: { confidential: false };
			const [projectRag, segments, chatMessages, previous] =
				await timings.time("contextGatherMs", () =>
					Promise.all([
						timings.time("projectRagMs", () =>
							retrieveProjectContextsActivity(
								turn.requestText,
								session.projectId,
								askerId,
								session.organizationId,
								PARLUME_PROJECT_RAG_CHUNKS,
								{
									maxPassageChars:
										PARLUME_PROJECT_PASSAGE_CHARS,
								},
							),
						),
						timings.time("segmentsQueryMs", () =>
							db.parlumeMeetingSegment.findMany({
								where: {
									sessionId: session.id,
									source: "SPEECH",
									...confidentialFilter,
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
								where: {
									sessionId: session.id,
									source: "CHAT",
									...confidentialFilter,
								},
								select: { text: true, speakerName: true },
								orderBy: { createdAt: "desc" },
								take: MAX_PARLUME_CHAT_MESSAGES,
							}),
						),
						// Earlier answers of a confidential meeting may repeat its
						// confidential part, so they go with it.
						withConfidential
							? timings.time("historyQueryMs", () =>
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
								)
							: Promise.resolve([]),
					]),
				);
			const history = formatParlumeHistory(previous);
			const transcript = formatLiveTranscript(segments);
			const chat = formatMeetingChat(chatMessages);
			const voiceInstructions = parlumeTurnInstructions({
				replyChannel: realtimeJob ? "REALTIME" : turn.replyChannel,
				toolsReadOnly: session.toolsReadOnly,
			});
			return timings.time("agentRunMs", () =>
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
							onToolStart: (invocation) => {
								toolNames.add(invocation.source.originalName);
								return narrateTool?.(invocation);
							},
						},
						() =>
							executeParlumeAgent({
								agent,
								session,
								requesterUserId: askerId,
								turnId: turn.id,
								message: turn.requestText,
								voiceInstructions,
								knowledgeContext: [
									projectRag?.context,
									chat
										? `Recent meeting chat:\n${chat}`
										: null,
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
		};
		const result =
			fixedReply !== null || requesterUserId === null
				? {
						success: true,
						response:
							fixedReply ?? PARLUME_UNCONFIRMED_REQUESTER_REPLY,
						error: undefined,
					}
				: await answerAs(requesterUserId);
		if (!result.success) {
			stopLiveSpeech();
			logTiming("agent_failed");
			await fail(
				result.error || "Parlume agent execution failed.",
				"failed",
			);
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
			const [completed] = await db.$transaction([
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
				asker: turn.speakerName,
				request: turn.requestText,
				proposalTags,
			});
			if (delivery.note) {
				await db.parlumeMeetingTurn.updateMany({
					where: { id: turn.id, status: "COMPLETED" },
					data: { error: delivery.note },
				});
			}
			await auditCompleted(completed);
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
		if (pageOnly) {
			// The page shows the stored answer; it holds no turn of the voice.
			const completed = await db.parlumeMeetingTurn.updateMany({
				where: { id: turn.id, status: "RUNNING" },
				data: { status: "COMPLETED", completedAt: new Date() },
			});
			await auditCompleted(completed);
			logTiming("completed");
			parlumeActivityLog("info", "turn.completed", {
				sessionId: session.id,
				turnId: turn.id,
				replyChannel: "PAGE",
				responseChars: response.length,
				firstTextMs: firstTextAt
					? firstTextAt.getTime() - startedAt
					: null,
				totalMs: Date.now() - startedAt,
			});
			return;
		}
		if (!livePlayback) {
			const delivery = await finishParlumeChatReply({
				sessionId: session.id,
				turnId: turn.id,
				voiceGeneration: turn.voiceGeneration,
				text: response,
				header: postHeader("answer"),
				proposalTags,
			});
			const [completed] = await db.$transaction([
				db.parlumeMeetingTurn.updateMany({
					where: { id: turn.id, status: "RUNNING" },
					data: {
						status: "COMPLETED",
						completedAt: new Date(),
						...(delivery.sent
							? {}
							: {
									error: parlumeChatNotSentNote(
										delivery.reason,
										"The answer",
									),
								}),
					},
				}),
				db.parlumeMeetingSession.updateMany({
					where: { id: session.id, activeTurnId: turn.id },
					data: { activeTurnId: null },
				}),
			]);
			await auditCompleted(completed);
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
				header: postHeader("answer"),
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
		// detail and anything past the headline's length. A reply that says
		// more about a proposal the turn posted, such as what it leaves out,
		// is posted whole, as it is for a request typed in the chat. One the
		// bridge lost, the bot not back in time to hear the rest, posts every
		// sentence not heard, the headline's included.
		const qualifiesProposal =
			proposalTags.length > 0 &&
			!onlyNotesParlumeProposal(response, proposalTags);
		const rest =
			deliveryNote !== null || !chatAvailable
				? ""
				: qualifiesProposal
					? spokenReply.unheardText(0)
					: playback.lost
						? spokenReply.unheardText(playback.heard ?? 0)
						: spokenReply.chatText;
		const restDelivery = rest
			? await sendParlumeChatReply({
					sessionId: session.id,
					turnId: turn.id,
					voiceGeneration: turn.voiceGeneration,
					text: rest,
					header: postHeader("detail"),
				})
			: null;
		const restNote =
			!restDelivery || restDelivery.sent
				? null
				: parlumeChatNotSentNote(
						restDelivery.reason,
						"The rest of the answer",
					);
		const note = deliveryNote ?? restNote;
		const [completed] = await db.$transaction([
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
		await auditCompleted(completed);
		firstAudioAtMs = playback.firstAudioAt;
		logTiming("completed");
		parlumeActivityLog("info", "turn.completed", {
			sessionId: session.id,
			turnId: turn.id,
			voiceGeneration: turn.voiceGeneration,
			played: playback.played,
			interrupted: playback.interrupted,
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
		await fail("Parlume agent execution failed.", "failed");
	}
}
