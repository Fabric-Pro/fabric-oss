import { db } from "@repo/database";
import type { ParlumeMeetingSessionStatus } from "@repo/database/prisma/generated/enums";
import { deleteParlumeMeetingBotData } from "./parlume-attendee";
import { parlumeLog } from "./parlume-log";
import { resolveParlumeAttendeeSettings } from "./parlume-provider-settings";
import {
	recordParlumeMeetingProviderUsage,
	resolveParlumeMeetingEnd,
} from "./parlume-usage";

const MAX_PARLUME_TRANSCRIPT_CHARS = 1_000_000;
const MAX_PARLUME_TRANSCRIPT_RECORDS = 10_000;

const finalizableStatuses: ParlumeMeetingSessionStatus[] = [
	"JOINING",
	"ACTIVE",
	"LEAVING",
];
const failedStatus: ParlumeMeetingSessionStatus = "FAILED";

export async function cleanupParlumeProviderData(
	sessionId: string,
): Promise<void> {
	const session = await db.parlumeMeetingSession.findUnique({
		where: { id: sessionId },
		select: {
			providerBotId: true,
			providerDataDeletedAt: true,
			organizationId: true,
		},
	});
	if (!session?.providerBotId || session.providerDataDeletedAt) {
		return;
	}
	const attendee = await resolveParlumeAttendeeSettings(
		session.organizationId,
	);
	if (!attendee) {
		throw new Error("Parlume provider configuration is unavailable.");
	}
	await deleteParlumeMeetingBotData({
		attendee,
		providerBotId: session.providerBotId,
	});
	await db.parlumeMeetingSession.update({
		where: { id: sessionId },
		data: { providerDataDeletedAt: new Date() },
	});
}

export async function finalizeParlumeSession(
	sessionId: string,
	options: {
		preserveFailure?: boolean;
		expectedStreamGeneration?: number;
	} = {},
): Promise<void> {
	const session = await db.parlumeMeetingSession.findUnique({
		where: { id: sessionId },
		select: {
			id: true,
			projectId: true,
			organizationId: true,
			userId: true,
			providerBotId: true,
			status: true,
			endReason: true,
			joinedAt: true,
			terminalCallbackAt: true,
			leaveRequestedAt: true,
			captureStoppedAt: true,
			finalizedAt: true,
			transcriptContextId: true,
			createdAt: true,
		},
	});
	if (!session?.providerBotId) {
		throw new Error("Parlume session cannot be finalized.");
	}

	let transcriptContextId = session.transcriptContextId;
	let finalizedNow = false;
	// A session finalizes once: its provider usage is recorded at that moment, so
	// a later call (a watchdog or a redelivered callback) must not claim it again.
	if (
		!transcriptContextId &&
		session.status !== "ENDED" &&
		!session.finalizedAt
	) {
		const claimedAt = new Date();
		const claimed = await db.parlumeMeetingSession.updateMany({
			where: {
				id: session.id,
				...(options.expectedStreamGeneration === undefined
					? {}
					: {
							streamGeneration: options.expectedStreamGeneration,
						}),
				OR: [
					{ status: { in: finalizableStatuses } },
					...(options.preserveFailure
						? [{ status: failedStatus, finalizedAt: null }]
						: []),
					{
						status: "FINALIZING",
						finalizationStartedAt: {
							lt: new Date(Date.now() - 5 * 60 * 1000),
						},
					},
				],
			},
			data: { status: "FINALIZING", finalizationStartedAt: claimedAt },
		});
		if (claimed.count === 0) {
			throw new Error("Parlume finalization is already in progress.");
		}
		// A claim older than five minutes can be taken over, so only the attempt
		// still holding its claim may finish: a stalled one that resumes then
		// saves no second transcript and records no second bot time.
		const stillClaimed = {
			id: session.id,
			status: "FINALIZING",
			finalizationStartedAt: claimedAt,
		} as const;
		const requireClaim = ({ count }: { count: number }) => {
			if (count === 0) {
				throw new Error(
					"Parlume finalization was taken over by a later attempt.",
				);
			}
		};

		const where = {
			sessionId: session.id,
			projectId: session.projectId,
			organizationId: session.organizationId,
		};
		const [segments, turns, actions] = await Promise.all([
			db.parlumeMeetingSegment.findMany({
				where,
				select: { text: true, speakerName: true, source: true },
				orderBy: [{ utteranceStartMs: "asc" }, { createdAt: "asc" }],
				take: MAX_PARLUME_TRANSCRIPT_RECORDS + 1,
			}),
			db.parlumeMeetingTurn.findMany({
				where,
				select: {
					id: true,
					requestText: true,
					responseText: true,
					status: true,
					interruptedAt: true,
				},
				orderBy: [{ createdAt: "asc" }, { id: "asc" }],
				take: MAX_PARLUME_TRANSCRIPT_RECORDS + 1,
			}),
			db.parlumeAction.findMany({
				where,
				select: { turnId: true, toolName: true, status: true },
				orderBy: [{ createdAt: "asc" }, { id: "asc" }],
				take: MAX_PARLUME_TRANSCRIPT_RECORDS + 1,
			}),
		]);
		if (
			[segments, turns, actions].some(
				(records) => records.length > MAX_PARLUME_TRANSCRIPT_RECORDS,
			)
		) {
			throw new Error("Parlume transcript exceeds the record limit.");
		}
		const actionsByTurn = new Map<string, typeof actions>();
		for (const turn of turns) {
			actionsByTurn.set(turn.id, []);
		}
		for (const action of actions) {
			const turnActions = actionsByTurn.get(action.turnId);
			if (!turnActions) {
				throw new Error(
					"Parlume action has no matching scoped request.",
				);
			}
			turnActions.push(action);
		}
		let content = "";
		const append = (line: string) => {
			if (
				content.length + line.length + 1 >
				MAX_PARLUME_TRANSCRIPT_CHARS
			) {
				throw new Error(
					"Parlume transcript exceeds the storage limit.",
				);
			}
			content += `${line}\n`;
		};
		if (segments.length) {
			append("Captured incoming speech:");
		}
		for (const segment of segments) {
			const line = segment.speakerName
				? `${segment.speakerName}: ${segment.text}`
				: segment.text;
			append(segment.source === "CHAT" ? `[chat] ${line}` : line);
		}
		if (turns.length) {
			append("\nRecorded Fabric responses and action receipts:");
			append(
				"Responses are generated text. A COMPLETED request does not prove action success or audio delivery. PENDING/RUNNING requests are incomplete. Playback interruption does not determine action success.",
			);
			append(
				"Only COMPLETED action receipts confirm success; all other action statuses are unsuccessful or unconfirmed.",
			);
			for (const [index, turn] of turns.entries()) {
				append(`\nRequest ${index + 1}: ${turn.requestText}`);
				append(`Request status: ${turn.status}`);
				append(
					`Playback interrupted: ${turn.interruptedAt ? "yes" : "not recorded"}`,
				);
				append(
					`Response: ${turn.responseText || "No response text recorded."}`,
				);
				const turnActions = actionsByTurn.get(turn.id);
				if (turnActions?.length) {
					for (const action of turnActions) {
						append(
							`Action receipt: ${action.toolName} — ${action.status}`,
						);
					}
				} else {
					append(
						"Action receipts: none recorded (action success unconfirmed).",
					);
				}
			}
		}
		if (!content) {
			requireClaim(
				await db.parlumeMeetingSession.updateMany({
					where: stillClaimed,
					data: {
						status: options.preserveFailure ? "FAILED" : "ENDED",
						finalizedAt: new Date(),
						endedAt: new Date(),
						// A bot that never got past the lobby had nothing to
						// hear; its end reason already says what happened.
						...(options.preserveFailure || !session.joinedAt
							? {}
							: {
									lastError:
										"No final speech segments were received.",
								}),
					},
				}),
			);
		} else {
			transcriptContextId = await db.$transaction(async (tx) => {
				const context = await tx.projectContext.create({
					data: {
						projectId: session.projectId,
						type: "MEETING_TRANSCRIPT",
						content,
						sourceTitle: "Parlume meeting transcript",
						userId: session.userId,
						organizationId: session.organizationId,
						metadata: {
							provider: "attendee",
							parlumeSessionId: session.id,
							parlumeNotesStatus: "PENDING",
						},
						extractionStatus: "COMPLETED",
						extractedAt: new Date(),
					},
					select: { id: true },
				});
				requireClaim(
					await tx.parlumeMeetingSession.updateMany({
						where: stillClaimed,
						data: {
							transcriptContextId: context.id,
							status: options.preserveFailure
								? "FAILED"
								: "ENDED",
							finalizedAt: new Date(),
							endedAt: new Date(),
							...(options.preserveFailure
								? {}
								: { lastError: null }),
						},
					}),
				);
				return context.id;
			});
		}
		finalizedNow = true;
	}
	if (finalizedNow) {
		const endedAt = resolveParlumeMeetingEnd(session, new Date());
		recordParlumeMeetingProviderUsage({
			sessionId: session.id,
			userId: session.userId,
			organizationId: session.organizationId,
			projectId: session.projectId,
			requestedAt: session.createdAt,
			joinedAt: session.joinedAt,
			endedAt,
			success: !options.preserveFailure,
		});
		parlumeLog("info", "session.finalized", {
			sessionId: session.id,
			botId: session.providerBotId,
			endReason: session.endReason,
			failed: Boolean(options.preserveFailure),
			transcriptSaved: transcriptContextId !== null,
			meetingMs: session.joinedAt
				? endedAt.getTime() - session.joinedAt.getTime()
				: null,
			botMs: endedAt.getTime() - session.createdAt.getTime(),
		});
	}
	if (transcriptContextId) {
		const { getTemporalClient } = await import("@repo/temporal");
		const temporal = await getTemporalClient();
		await temporal.workflow.start("contextEmbeddingWorkflow", {
			workflowIdConflictPolicy: "USE_EXISTING",
			taskQueue: "project-documents",
			workflowId: `context-embedding-parlume-${session.id}`,
			args: [
				{
					contextId: transcriptContextId,
					projectId: session.projectId,
					userId: session.userId,
					organizationId: session.organizationId,
					type: "MEETING_TRANSCRIPT",
					metadata: {
						sourceTitle: "Parlume meeting transcript",
						provider: "attendee",
						parlumeSessionId: session.id,
					},
				},
			],
		});
		await temporal.workflow.start("parlumeNotesWorkflow", {
			workflowIdConflictPolicy: "USE_EXISTING",
			taskQueue: "project-documents",
			workflowId: `parlume-notes-${session.id}`,
			args: [
				{
					sessionId: session.id,
					// For the shared-plan wait's reset estimate (Fizzy #2770).
					organizationId: session.organizationId,
					userId: session.userId,
				},
			],
		});
	}

	await cleanupParlumeProviderData(session.id);
}
