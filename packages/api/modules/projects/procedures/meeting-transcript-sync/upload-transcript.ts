import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { config } from "@repo/config";
import {
	createFileContext,
	db,
	findUploadedTranscript,
	getContextById,
	UPLOADED_TRANSCRIPT_PROVIDER,
	updateContextExtractionStatus,
	uploadedTranscriptKeys,
} from "@repo/database";
import { logger } from "@repo/logs";
import { getStorageProvider } from "@repo/storage";
import { getTemporalClient } from "@repo/temporal";
import {
	formatSizeLimit,
	TRANSCRIPT_UPLOAD_FORMAT_LIST,
	TRANSCRIPT_UPLOAD_FORMATS,
	TRANSCRIPT_UPLOAD_MAX_BYTES,
	transcriptUploadFormatOf,
} from "@repo/utils";
import { z } from "zod";
import { assertInputOrgMatchesProject } from "../../../../lib/authorized-project-tenant";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

function isAlreadyStarted(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.name === "WorkflowExecutionAlreadyStartedError"
	);
}

/** The analysis again, on a transcript already stored. */
async function reprocessTranscript(params: {
	projectId: string;
	organizationId: string | undefined;
	userId: string;
	transcriptRecordId: string;
}) {
	const client = await getTemporalClient();
	try {
		await client.workflow.start(
			"extractMeetingInsightsOnDemandWorkflow",
			withCorrelationMemo({
				taskQueue: "project-documents",
				workflowId: `meeting-digest-insights:${params.transcriptRecordId}`,
				workflowIdReusePolicy: "ALLOW_DUPLICATE",
				workflowIdConflictPolicy: "FAIL",
				args: [
					{
						projectId: params.projectId,
						organizationId: params.organizationId,
						userId: params.userId,
						transcriptCuid: params.transcriptRecordId,
						force: true,
					},
				],
			}),
		);
	} catch (error) {
		if (!isAlreadyStarted(error)) {
			throw error;
		}
	}
}

/**
 * Where to send a transcript file (Fizzy #1877), and whether to send it at all.
 *
 * The browser hashes the file first, so that a file this project already has
 * can be asked about before anything is uploaded. The hash is only a question
 * here: the activity hashes the bytes that actually arrive, and the unique index
 * is what finally decides.
 */
export const createTranscriptUploadUrlProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.CONTEXT_CREATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/meeting-transcript-sync/upload-url",
		tags: ["Projects", "Meeting Transcript Sync"],
		summary: "Create a transcript upload URL",
		description:
			"Checks a transcript file and returns where to upload it, or says the project already has it.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			filename: z.string().min(1).max(255),
			size: z.number().int().nonnegative(),
			contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
			/** The user saw the duplicate answer and chose to run it again. */
			reprocess: z.boolean().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { projectId, filename, size, contentSha256, reprocess } = input;
		const user = context.user;

		// The middleware authorized this project; the tenant comes from its row.
		const project = await db.project.findUnique({
			where: { id: projectId },
			select: { id: true, organizationId: true },
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}
		assertInputOrgMatchesProject(input.organizationId, project);
		const organizationId = project.organizationId ?? undefined;

		const format = transcriptUploadFormatOf(filename);
		if (!format) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Unsupported file type for "${filename}". Supported formats: ${TRANSCRIPT_UPLOAD_FORMAT_LIST}.`,
			});
		}
		if (size > TRANSCRIPT_UPLOAD_MAX_BYTES) {
			throw new ORPCError("BAD_REQUEST", {
				message: `File ${filename} is too large. ${formatSizeLimit(TRANSCRIPT_UPLOAD_MAX_BYTES)}.`,
			});
		}

		const existing = await findUploadedTranscript(projectId, contentSha256);
		if (existing) {
			if (!reprocess) {
				return {
					status: "duplicate" as const,
					meetingSubject: existing.meetingSubject,
					addedAt: existing.syncedAt,
				};
			}
			await reprocessTranscript({
				projectId,
				organizationId,
				userId: user.id,
				transcriptRecordId: existing.id,
			});
			return { status: "reprocessing" as const };
		}

		const contentType = TRANSCRIPT_UPLOAD_FORMATS[format];
		// UUID so storage paths are not enumerable from a leaked neighbor.
		const s3Path = `projects/${projectId}/ctx_${randomUUID()}.${format}`;
		const bucket = config.storage.bucketNames.projectContexts;

		const storageProvider = getStorageProvider();
		const signedUploadUrl =
			storageProvider.supportsPresignedUrls &&
			storageProvider.getSignedUploadUrl
				? await storageProvider.getSignedUploadUrl(s3Path, {
						bucket,
						contentType,
						// Signed so storage refuses anything larger than was
						// checked above. The worker reads the object into memory.
						contentLength: size,
					})
				: null;

		const meetingSubject = filename.replace(/\.[^/.]+$/, "");
		const { meetingId } = uploadedTranscriptKeys(contentSha256);
		const projectContext = await createFileContext({
			projectId,
			type: "MEETING_TRANSCRIPT",
			s3Path,
			s3Bucket: bucket,
			originalFilename: filename,
			mimeType: contentType,
			fileSize: size,
			metadata: {
				title: meetingSubject,
				provider: UPLOADED_TRANSCRIPT_PROVIDER,
				transcriptSource: "upload",
				meetingId,
				meetingSubject,
				uploadedBy: user.id,
				uploadedAt: new Date().toISOString(),
			},
			userId: user.id,
			organizationId,
		});

		return {
			status: "upload" as const,
			contextId: projectContext.id,
			signedUploadUrl,
			s3Path,
			useServerUpload: !storageProvider.supportsPresignedUrls,
			storageProvider: storageProvider.type,
			contentType,
		};
	});

/** The file has arrived: read it and file it as a transcript. */
export const startTranscriptUploadIngestProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.CONTEXT_CREATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/meeting-transcript-sync/uploads/{contextId}/ingest",
		tags: ["Projects", "Meeting Transcript Sync"],
		summary: "Ingest an uploaded transcript",
		description:
			"Starts reading an uploaded transcript file into the project's transcripts.",
	})
	.input(
		z.object({
			projectId: z.string(),
			contextId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { projectId, contextId } = input;
		const user = context.user;

		const projectContext = await getContextById(contextId);
		const metadata = (projectContext?.metadata ?? {}) as {
			provider?: string;
		};
		if (
			!projectContext ||
			projectContext.projectId !== projectId ||
			projectContext.type !== "MEETING_TRANSCRIPT" ||
			metadata.provider !== UPLOADED_TRANSCRIPT_PROVIDER
		) {
			throw new ORPCError("NOT_FOUND", {
				message: "Uploaded transcript not found",
			});
		}

		// The row's own organization, as for any other uploaded context.
		const organizationId = projectContext.organizationId || undefined;

		// A conditional write, not a read then a write: two calls can both see
		// PENDING, and a late one must not put a finished row back to EXTRACTING.
		const claim = await db.projectContext.updateMany({
			where: { id: contextId, projectId, extractionStatus: "PENDING" },
			data: { extractionStatus: "EXTRACTING" },
		});
		if (claim.count === 0) {
			throw new ORPCError("CONFLICT", {
				message: "This transcript is already being processed.",
			});
		}

		try {
			const client = await getTemporalClient();
			await client.workflow.start(
				"uploadedTranscriptIngestWorkflow",
				withCorrelationMemo({
					taskQueue: "project-documents",
					// Deterministic: a second call for this row cannot start a
					// second run, even after the first has closed. `retryStalled`
					// uses a fresh id on purpose.
					workflowId: `uploaded-transcript-ingest-${contextId}`,
					workflowIdReusePolicy: "REJECT_DUPLICATE",
					workflowIdConflictPolicy: "FAIL",
					args: [
						{
							contextId,
							projectId,
							userId: user.id,
							organizationId,
						},
					],
				}),
			);
		} catch (error) {
			if (!isAlreadyStarted(error)) {
				await updateContextExtractionStatus(contextId, "PENDING");
				logger.error(
					"[TranscriptUpload] Failed to start the ingest workflow",
					{
						contextId,
						error:
							error instanceof Error
								? error.message
								: String(error),
					},
				);
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message: "Failed to start processing this transcript",
				});
			}
		}

		return { status: "EXTRACTING" as const };
	});
