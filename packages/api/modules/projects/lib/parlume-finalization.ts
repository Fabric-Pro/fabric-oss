import { db } from "@repo/database";
import type { ParlumeMeetingSessionStatus } from "@repo/database/prisma/generated/enums";
import { parlumeLog } from "./parlume-log";
import {
	deleteParlumeMeetingBotData,
	getParlumeBridgeSettings,
} from "./parlume-meeting-baas";
import {
	recordParlumeMeetingProviderUsage,
	resolveParlumeMeetingEnd,
} from "./parlume-usage";

const MAX_PARLUME_TRANSCRIPT_CHARS = 1_000_000;

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
		select: { providerBotId: true, providerDataDeletedAt: true },
	});
	if (!session?.providerBotId || session.providerDataDeletedAt) {
		return;
	}
	const settings = getParlumeBridgeSettings();
	if (!settings) {
		throw new Error("Parlume provider configuration is unavailable.");
	}
	await deleteParlumeMeetingBotData({
		settings,
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
			transcriptContextId: true,
		},
	});
	if (!session?.providerBotId) {
		throw new Error("Parlume session cannot be finalized.");
	}

	let transcriptContextId = session.transcriptContextId;
	let finalizedNow = false;
	if (!transcriptContextId && session.status !== "ENDED") {
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
						? [{ status: failedStatus }]
						: []),
					{
						status: "FINALIZING",
						finalizationStartedAt: {
							lt: new Date(Date.now() - 5 * 60 * 1000),
						},
					},
				],
			},
			data: { status: "FINALIZING", finalizationStartedAt: new Date() },
		});
		if (claimed.count === 0) {
			throw new Error("Parlume finalization is already in progress.");
		}
		finalizedNow = true;

		const segments = await db.parlumeMeetingSegment.findMany({
			where: { sessionId: session.id },
			select: {
				text: true,
				speakerName: true,
				utteranceStartMs: true,
				utteranceEndMs: true,
				createdAt: true,
			},
			orderBy: [{ utteranceStartMs: "asc" }, { createdAt: "asc" }],
			take: 10_000,
		});
		let content = "";
		for (const segment of segments) {
			const line = segment.speakerName
				? `${segment.speakerName}: ${segment.text}`
				: segment.text;
			if (
				content.length + line.length + 1 >
				MAX_PARLUME_TRANSCRIPT_CHARS
			) {
				throw new Error(
					"Parlume transcript exceeds the storage limit.",
				);
			}
			content += `${line}\n`;
		}
		if (!content) {
			await db.parlumeMeetingSession.update({
				where: { id: session.id },
				data: {
					status: options.preserveFailure ? "FAILED" : "ENDED",
					finalizedAt: new Date(),
					endedAt: new Date(),
					...(options.preserveFailure
						? {}
						: {
								lastError:
									"No final speech segments were received.",
							}),
				},
			});
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
							provider: "meetingbaas",
							parlumeSessionId: session.id,
							parlumeNotesStatus: "PENDING",
						},
						extractionStatus: "COMPLETED",
						extractedAt: new Date(),
					},
					select: { id: true },
				});
				await tx.parlumeMeetingSession.update({
					where: { id: session.id },
					data: {
						transcriptContextId: context.id,
						status: options.preserveFailure ? "FAILED" : "ENDED",
						finalizedAt: new Date(),
						endedAt: new Date(),
						...(options.preserveFailure ? {} : { lastError: null }),
					},
				});
				return context.id;
			});
		}
	}
	if (finalizedNow) {
		const endedAt = resolveParlumeMeetingEnd(session, new Date());
		recordParlumeMeetingProviderUsage({
			sessionId: session.id,
			userId: session.userId,
			organizationId: session.organizationId,
			projectId: session.projectId,
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
						provider: "meetingbaas",
						parlumeSessionId: session.id,
					},
				},
			],
		});
		await temporal.workflow.start("parlumeNotesWorkflow", {
			workflowIdConflictPolicy: "USE_EXISTING",
			taskQueue: "project-documents",
			workflowId: `parlume-notes-${session.id}`,
			args: [{ sessionId: session.id }],
		});
	}

	await cleanupParlumeProviderData(session.id);
}
