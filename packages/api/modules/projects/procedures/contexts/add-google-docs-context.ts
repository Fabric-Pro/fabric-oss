/**
 * addGoogleDocsContext — ingest selected Google Docs into a project's RAG
 * context store (spec 2026-05-22-google-docs-project-context, Task 4).
 *
 * For each selected file: export the Doc body to plain text (server-side),
 * materialise that text into the project-context S3 bucket, create an
 * `INTEGRATION` ProjectContext row pointing at the object, flip it to
 * `EXTRACTING`, and start the EXISTING `projectContextProcessingWorkflow`.
 * That workflow downloads the object, extracts (text/plain is handled
 * directly), chunks, embeds into Qdrant, and flips the row to
 * `COMPLETED`/`FAILED` — so AI Backlog Update consumes the content for free.
 *
 * Each file is wrapped in its own try/catch so one bad doc (inaccessible,
 * export failure, workflow-start failure) does not abort the batch: we
 * return `{ created, failed, skipped, duplicates }` and mark any row we managed
 * to create `FAILED` with the underlying error. Files beyond the per-project
 * INTEGRATION cap are reported as `skipped`; Docs already ingested into this
 * project are reported as `duplicates` and not re-added.
 *
 * Modeled on `process-context-link.ts` and `process-context-file.ts`.
 */
import { ORPCError } from "@orpc/server";
import {
	countContextsByType,
	createBackgroundJob,
	createContext,
	db,
	failBackgroundJob,
	hasProjectAccess,
	seedSteps,
	updateContextExtractionStatus,
} from "@repo/database";
import { logger } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	exportGoogleDocText,
	GoogleDriveExportAuthError,
} from "../../../integrations/lib/google-drive-rest";
import {
	GoogleDriveNotConnectedError,
	GoogleDriveTokenExpiredError,
	getGoogleDriveAccessToken,
} from "../../../integrations/lib/google-drive-token";
import {
	deleteUploadedContextText,
	uploadContextText,
} from "../lib/s3-context-upload";

// Same task queue used by `process-context-file` / `process-context-link`.
const PROJECT_CONTEXT_TASK_QUEUE = "project-documents";

// Per-project cap on INTEGRATION contexts, matching `create-context.ts`. The
// batch path must enforce the same ceiling or it becomes an end-run around the
// single-add limit (Qdrant cost / RAG dilution).
const MAX_INTEGRATION_CONTEXTS = 30;

export const addGoogleDocsContextProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.CONTEXT_CREATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/contexts/google-docs",
		tags: ["Projects", "Contexts", "Integrations"],
		summary: "Add Google Docs as project context",
		description:
			"Export selected Google Docs to text and ingest them into the project RAG context store via the project-context processing workflow.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			files: z
				.array(
					z.object({
						id: z.string(),
						title: z.string(),
						url: z.string().nullable().optional(),
					}),
				)
				.min(1)
				.max(20),
		}),
	)
	.output(
		z.object({
			created: z.number(),
			failed: z.number(),
			skipped: z.number(),
			duplicates: z.number(),
			/**
			 * Subset of `failed` whose root cause was a Drive 401/403. The
			 * client surfaces a "Reconnect Google" CTA when this is nonzero,
			 * since a token revocation invalidates every file in the batch
			 * and the right remediation is re-auth, not retry.
			 */
			authFailed: z.number(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const hasAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// Resolve the Drive token once for the whole batch. A connection /
		// expiry problem is a whole-request failure (nothing can be ingested).
		// Map the typed sentinel errors to actionable ORPCErrors (mirroring the
		// picker procedure) so the client gets a guided reconnect prompt instead
		// of a raw INTERNAL_SERVER_ERROR (story AC-5 / AC-10).
		let token: string;
		try {
			token = await getGoogleDriveAccessToken({
				userId: user.id,
				organizationId,
			});
		} catch (error) {
			if (error instanceof GoogleDriveNotConnectedError) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"Google account not connected. Connect it in Settings → Integrations.",
					data: { code: "GOOGLE_NOT_CONNECTED" },
				});
			}
			if (error instanceof GoogleDriveTokenExpiredError) {
				throw new ORPCError("UNAUTHORIZED", {
					message:
						"Google session expired. Reconnect your account in Settings → Integrations.",
					data: { code: "GOOGLE_TOKEN_EXPIRED" },
				});
			}
			throw error;
		}

		const temporalClient = await getTemporalClient();

		// Enforce the per-project INTEGRATION cap (same ceiling as the
		// single-add path). We count once up front and stop creating once the
		// existing rows plus the ones created in this batch hit the cap;
		// remaining files are reported as `skipped` so the UI can tell the user.
		const contextCounts = await countContextsByType(input.projectId);
		const existingIntegrationCount = contextCounts.INTEGRATION ?? 0;

		// Dedup: a Google Doc already ingested into this project must not be
		// added again (it would create a duplicate ProjectContext row, double
		// the Qdrant cost, and dilute RAG). Build the set of googleFileIds
		// already present once, and extend it as we create rows so repeats
		// within this same batch are caught too.
		const existingGoogleFileIds = await loadExistingGoogleFileIds(
			input.projectId,
		);

		let created = 0;
		let failed = 0;
		let skipped = 0;
		let duplicates = 0;
		let authFailed = 0;

		for (const file of input.files) {
			if (existingGoogleFileIds.has(file.id)) {
				duplicates++;
				continue;
			}

			if (
				existingIntegrationCount + created >=
				MAX_INTEGRATION_CONTEXTS
			) {
				skipped++;
				continue;
			}

			// Track uploaded S3 location outside the inner scope so the catch
			// can clean up an orphaned object if anything between upload and
			// successful workflow.start fails. Without this, a createContext
			// or workflow.start failure leaves the bucket leaking bytes.
			let uploaded: { s3Path: string; s3Bucket: string } | undefined;
			let contextId: string | undefined;
			let workflowStarted = false;
			try {
				const text = await exportGoogleDocText({
					token,
					fileId: file.id,
				});

				const { s3Path, s3Bucket, fileSize } = await uploadContextText({
					projectId: input.projectId,
					text,
				});
				uploaded = { s3Path, s3Bucket };

				const ctxRow = await createContext({
					projectId: input.projectId,
					type: "INTEGRATION",
					// Filled by the processing workflow after extraction.
					content: "",
					sourceUrl: file.url ?? undefined,
					sourceTitle: file.title,
					mimeType: "text/plain",
					s3Path,
					s3Bucket,
					originalFilename: `${file.title}.txt`,
					fileSize,
					metadata: {
						googleFileId: file.id,
						source: "google-docs",
						addedBy: user.id,
						addedAt: new Date().toISOString(),
					},
					userId: user.id,
					organizationId,
				});
				contextId = ctxRow.id;

				// Start the workflow BEFORE flipping the row to EXTRACTING.
				// Order matters: a workflow.start failure must leave the row
				// in PENDING so the catch below can mark it FAILED and clean
				// up S3 cleanly. The previous order ran the EXTRACTING write
				// first, which on a swallowed FAILED update left the row
				// permanently in EXTRACTING with no workflow running.
				await temporalClient.workflow.start(
					"projectContextProcessingWorkflow",
					withCorrelationMemo({
						taskQueue: PROJECT_CONTEXT_TASK_QUEUE,
						// Deterministic ID → idempotent re-starts for one row.
						workflowId: `project-context-processing-${contextId}`,
						args: [
							{
								contextId,
								projectId: input.projectId,
								userId: user.id,
								organizationId: organizationId ?? undefined,
								extractionStrategy: "local-only",
							},
						],
					}),
				);
				workflowStarted = true;

				// Job Hub: Google Docs land as INTEGRATION contexts, which is
				// exactly the case where the UI used to show a decorative
				// "Live" chip and hide real ingestion state. The job row is the
				// honest signal. Created after the start so a failed start
				// leaves no row behind.
				await createBackgroundJob({
					kind: "CONTEXT_PROCESSING",
					title: file.title,
					projectId: input.projectId,
					userId: user.id,
					organizationId: organizationId ?? null,
					workflowId: `project-context-processing-${contextId}`,
					sourceType: "projectContext",
					sourceId: contextId,
					steps: seedSteps([
						"download",
						"extract",
						"chunk",
						"embed",
						"store",
					]),
				});

				// Now safe to advertise EXTRACTING — the workflow is live and
				// will continue to update the row's status as it progresses,
				// so a write failure here is recoverable (the workflow
				// supplies the next status). Log-warn-only on miss.
				await updateContextExtractionStatus(
					contextId,
					"EXTRACTING",
				).catch((updateErr) => {
					logger.warn(
						`[AddGoogleDocs] Failed to flip context ${contextId} to EXTRACTING (workflow already running): ${updateErr instanceof Error ? updateErr.message : String(updateErr)}`,
					);
				});

				created++;
				// Guard against the same fileId appearing twice in one batch.
				existingGoogleFileIds.add(file.id);
				logger.info(
					`[AddGoogleDocs] Ingested Google Doc ${file.id} as context ${contextId}`,
				);
			} catch (error) {
				failed++;
				// Track auth failures separately so the client can render a
				// reconnect CTA. A single 401/403 is unlikely to be per-file;
				// it usually means the token was revoked between when we
				// minted it for this batch and when the batch ran.
				if (error instanceof GoogleDriveExportAuthError) {
					authFailed++;
				}
				const message =
					error instanceof Error ? error.message : "Unknown error";
				logger.error(
					`[AddGoogleDocs] Failed to ingest Google Doc ${file.id}: ${message}`,
				);
				// Mark the row FAILED so the UI's status reflects reality.
				// Best-effort — never let a bookkeeping failure mask the batch.
				if (contextId) {
					await updateContextExtractionStatus(contextId, "FAILED", {
						extractionError: `Google Docs ingestion failed: ${message}`,
					}).catch((updateErr) => {
						logger.error(
							`[AddGoogleDocs] Failed to mark context ${contextId} FAILED: ${updateErr}`,
						);
					});
					// Close the Job Hub row with the real reason. Only exists
					// once the workflow started; left open it would keep
					// counting toward the nav badge until the watchdog
					// mislabelled it "Timed out".
					if (workflowStarted) {
						await failBackgroundJob(
							{
								workflowId: `project-context-processing-${contextId}`,
								sourceId: contextId,
							},
							{
								error: `Google Docs ingestion failed: ${message}`,
							},
						);
					}
				}
				// Clean up an orphaned S3 object whenever the workflow never
				// took ownership of it — either the row was never created or
				// the workflow never started. Without this, every failed
				// ingest leaks bytes into project-contexts/. Best-effort:
				// `deleteUploadedContextText` swallows its own errors.
				if (uploaded && !workflowStarted) {
					await deleteUploadedContextText(uploaded);
				}
			}
		}

		return { created, failed, skipped, duplicates, authFailed };
	});

/**
 * Load the set of Google Doc file ids already ingested as context for a
 * project, so we never create a duplicate ProjectContext for the same Doc.
 * Reads `metadata.googleFileId` off the project's INTEGRATION contexts.
 */
async function loadExistingGoogleFileIds(
	projectId: string,
): Promise<Set<string>> {
	const rows = await db.projectContext.findMany({
		where: { projectId, type: "INTEGRATION" },
		select: { metadata: true },
	});
	const ids = new Set<string>();
	for (const row of rows) {
		const meta = row.metadata as { googleFileId?: unknown } | null;
		if (meta && typeof meta.googleFileId === "string") {
			ids.add(meta.googleFileId);
		}
	}
	return ids;
}
