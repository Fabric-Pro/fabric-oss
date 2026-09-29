import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
	deleteParlumeMeetingBotData,
	getParlumeBridgeSettings,
} from "@repo/api/modules/projects/lib/parlume-meeting-baas";
import { db } from "@repo/database";
import type { ParlumeMeetingSessionStatus } from "@repo/database/prisma/generated/enums";

export const MAX_PARLUME_SEGMENT_CHARS = 20_000;
const MAX_PARLUME_TRANSCRIPT_CHARS = 1_000_000;

const finalizableStatuses: ParlumeMeetingSessionStatus[] = [
	"JOINING",
	"ACTIVE",
	"LEAVING",
];
const failedStatus: ParlumeMeetingSessionStatus = "FAILED";

function digest(value: string): Buffer {
	return createHash("sha256").update(value).digest();
}

export function constantTimeEqual(
	provided: string | null,
	expected: string | undefined,
): boolean {
	if (!provided || !expected) {
		return false;
	}
	return timingSafeEqual(digest(provided), digest(expected));
}

export function isParlumeServiceRequestAuthorized(
	provided: string | null,
): boolean {
	return constantTimeEqual(provided, process.env.AGENT_SERVICE_SECRET);
}

export function streamTokenDigest(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

export function callbackSecret(sessionId: string): string | null {
	const serviceSecret = process.env.AGENT_SERVICE_SECRET;
	if (!serviceSecret) {
		return null;
	}
	return createHmac("sha256", serviceSecret)
		.update(`parlume-callback:${sessionId}`)
		.digest("base64url");
}

export function segmentDedupeKey(input: {
	sessionId: string;
	text: string;
	speakerName: string | null;
	speakerId: string | null;
	utteranceStartMs: number | null;
	utteranceEndMs: number | null;
}): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				input.sessionId,
				input.text,
				input.speakerName,
				input.speakerId,
				input.utteranceStartMs,
				input.utteranceEndMs,
			]),
		)
		.digest("hex");
}

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
			transcriptContextId: true,
		},
	});
	if (!session?.providerBotId) {
		throw new Error("Parlume session cannot be finalized.");
	}

	let transcriptContextId = session.transcriptContextId;
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
					{
						status: {
							in: finalizableStatuses,
						},
					},
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
