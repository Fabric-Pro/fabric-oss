/**
 * `projects.contexts.createBatchDownloadUrl` — stream all contexts for a
 * project into a single ZIP and return a presigned GET URL.
 *
 * See spec §6.2, §4.6, §4.7, §8.1, §10, §11 in
 * `docs/specs/2026-04-15-download-project-context-files/spec.md`.
 *
 * Streaming model:
 *   archiver (Readable) → putObjectStream (lib-storage Upload, multipart)
 *
 * The procedure never buffers the full archive in memory. Per-file read
 * failures are caught and recorded in the MANIFEST's SKIPPED section — they
 * do not abort the archive. The MANIFEST is always the last entry appended.
 *
 * Tenant isolation: enforced at the procedure boundary
 * (`tenantProtectedProcedure`, `requireProjectPermission(CONTEXT_READ)`,
 * `verifyOrganizationMembership` for org context) and on the project lookup
 * (`getProjectForDownload`, which applies the XOR filter on userId +
 * organizationId). Once the project is resolved under the tenant's scope,
 * the context listing is project-scoped.
 */

import { randomUUID } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import { ORPCError } from "@orpc/server";
import { config } from "@repo/config";
import { getProjectForDownload, listContextsForDownload } from "@repo/database";
import { logger } from "@repo/logs";
import { getObjectStream, getSignedUrl, putObjectStream } from "@repo/storage";
import archiver from "archiver";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";
import { buildContextTextPayload } from "../../lib/build-context-text-payload";
import {
	classifyContext,
	dedupeFilename,
} from "../../lib/context-classification";
import { contextDownloadFilename } from "../../lib/context-download-filename";
import {
	buildContextDownloadManifest,
	type ManifestIncludedRow,
	type ManifestSkippedRow,
	type SkipReason,
} from "../../lib/context-download-manifest";
import {
	BATCH_PRESIGN_EXPIRY_SECONDS,
	MAX_BATCH_DOWNLOAD_BYTES,
	MAX_BATCH_DOWNLOAD_CONTEXTS,
} from "./constants";

// ---------------------------------------------------------------------------
// Zod input / output — spec §6.2
// ---------------------------------------------------------------------------

const createContextsBatchDownloadUrlInput = z.object({
	projectId: z.string().min(1),
	organizationId: z.string().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Slugify a free-text name for the outer ZIP filename. Mirrors spec §4.3. */
function slugifyProjectName(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "project";
}

/** Format a Date as `YYYY-MM-DD` in UTC. */
function utcDateStamp(date: Date): string {
	return date.toISOString().slice(0, 10);
}

/**
 * Pick the in-ZIP subfolder for a context entry. Mirrors spec §4.4:
 *   - Class A (FILE/IMAGE/DOCUMENT/SPREADSHEET) → `files/`
 *   - Class C (CODE_FILE/CODE_FILE_SUMMARY)     → `code/`
 *   - Class B LINK                              → `links/`
 *   - Class B MEETING_TRANSCRIPT                → `transcripts/`
 *   - Class B INTEGRATION                       → `integrations/{provider}/`
 *   - Class B TEXT / planning surfaces          → `notes/`
 */
function resolveSubfolder(
	klass: "A" | "B" | "C",
	type: string,
	integration: string | null,
): string {
	if (klass === "A") {
		return "files";
	}
	if (klass === "C") {
		return "code";
	}
	if (type === "LINK") {
		return "links";
	}
	if (type === "MEETING_TRANSCRIPT") {
		return "transcripts";
	}
	if (type === "INTEGRATION") {
		const provider = integration
			? integration
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, "-")
					.replace(/^-+|-+$/g, "")
			: "";
		return provider ? `integrations/${provider}` : "integrations";
	}
	return "notes";
}

/**
 * Map a thrown error to one of the stable `SkipReason` strings used in the
 * MANIFEST SKIPPED section.
 */
function mapErrorToSkipReason(err: unknown): SkipReason {
	const name = (err as { name?: string } | null | undefined)?.name ?? "";
	const code = (err as { Code?: string } | null | undefined)?.Code ?? "";
	if (name === "NoSuchKey" || name === "NotFound" || code === "NoSuchKey") {
		return "Source object not found in storage";
	}
	return "Storage read failed";
}

interface ContextRow {
	id: string;
	type: string;
	content: string | null;
	s3Path: string | null;
	s3Bucket: string | null;
	originalFilename: string | null;
	mimeType: string | null;
	fileSize: number | null;
	sourceTitle: string | null;
	sourceUrl: string | null;
	extractionStatus: string;
	metadata: unknown;
	createdAt: Date;
}

/** Extract a display title from metadata → sourceTitle → originalFilename. */
function resolveTitle(ctx: ContextRow): string {
	const meta = (ctx.metadata ?? {}) as Record<string, unknown>;
	const metaTitle = typeof meta.title === "string" ? meta.title : null;
	return (
		metaTitle ||
		ctx.sourceTitle ||
		ctx.originalFilename ||
		`context-${ctx.id}`
	);
}

/** Extract an integration provider slug, if any, from metadata. */
function resolveIntegrationProvider(ctx: ContextRow): string | null {
	const meta = (ctx.metadata ?? {}) as Record<string, unknown>;
	const provider = meta.provider ?? meta.integrationProvider ?? null;
	return typeof provider === "string" ? provider : null;
}

/**
 * Compute the total source bytes the batch would read. Class A contributes
 * its stored `fileSize` (falling back to 0). Class B/C contribute the UTF-8
 * byte length of their `content`.
 */
function computeTotalBytes(contexts: ReadonlyArray<ContextRow>): number {
	let total = 0;
	for (const ctx of contexts) {
		const klass = classifyContext(ctx);
		if (klass === "A") {
			total += ctx.fileSize ?? 0;
		} else {
			total += Buffer.byteLength(ctx.content ?? "", "utf8");
		}
	}
	return total;
}

// ---------------------------------------------------------------------------
// Procedure
// ---------------------------------------------------------------------------

export const createContextsBatchDownloadUrlProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.CONTEXT_READ))
	.route({
		method: "POST",
		path: "/projects/:projectId/contexts/batch-download-url",
		tags: ["Projects", "Contexts"],
		summary: "Create batch context ZIP download URL",
		description:
			"Stream every context of a project into a ZIP and return a presigned GET URL.",
	})
	.input(createContextsBatchDownloadUrlInput)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Active-member check for org context. Personal context is implicit via
		// `organizationId = undefined`.
		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				user.id,
			);
			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}
		}

		const tenant = {
			userId: user.id,
			organizationId: organizationId ?? null,
		};

		// 1. Load the project under tenant XOR.
		const project = await getProjectForDownload(input.projectId, tenant);
		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		// 2. Load all contexts (ordered by createdAt asc). Authorization for
		//    this project was already enforced by the procedure middleware and
		//    `getProjectForDownload` above, so the query is project-scoped.
		const contexts = (await listContextsForDownload(
			input.projectId,
		)) as unknown as ContextRow[];

		// 3. Enforce hard ceilings BEFORE streaming anything.
		const totalCount = contexts.length;
		const totalBytes = computeTotalBytes(contexts);

		if (totalCount > MAX_BATCH_DOWNLOAD_CONTEXTS) {
			throw new ORPCError("BAD_REQUEST", {
				message: "projects.contexts.download.tooLarge",
				data: {
					reason: "too_many" as const,
					count: totalCount,
					size: totalBytes,
					maxCount: MAX_BATCH_DOWNLOAD_CONTEXTS,
					maxSize: MAX_BATCH_DOWNLOAD_BYTES,
				},
			});
		}
		if (totalBytes > MAX_BATCH_DOWNLOAD_BYTES) {
			throw new ORPCError("BAD_REQUEST", {
				message: "projects.contexts.download.tooLarge",
				data: {
					reason: "too_large" as const,
					count: totalCount,
					size: totalBytes,
					maxCount: MAX_BATCH_DOWNLOAD_CONTEXTS,
					maxSize: MAX_BATCH_DOWNLOAD_BYTES,
				},
			});
		}

		// 4. Build the output filenames / S3 key.
		const now = new Date();
		const dateStamp = utcDateStamp(now);
		const filename = `${slugifyProjectName(project.name)}_context_${dateStamp}.zip`;
		const key = `downloads/project-contexts/${input.projectId}/${dateStamp}/${randomUUID()}.zip`;
		const bucket = config.storage.bucketNames.projectContexts;

		// 5. Create archiver + streaming upload pipeline.
		const archive = archiver("zip", { zlib: { level: 6 } });
		// Pipe archive into a PassThrough so the underlying `Upload` reads from
		// a plain Readable and we can attach error handlers without coupling.
		const archiveOutput = new PassThrough();
		archive.pipe(archiveOutput);

		const included: ManifestIncludedRow[] = [];
		const skipped: ManifestSkippedRow[] = [];
		const seenNames = new Map<string, number>();

		// Kick off the upload concurrently with the archive writes. We must
		// start consuming the archive output immediately or archiver will stall
		// on back-pressure.
		const uploadPromise = putObjectStream(key, archiveOutput, {
			bucket,
			contentType: "application/zip",
		});

		// Capture any fatal archiver/upload error so we can wrap it.
		let fatalError: unknown = null;
		archive.on("error", (err) => {
			fatalError = err;
		});

		for (const ctx of contexts) {
			const title = resolveTitle(ctx);
			const integration = resolveIntegrationProvider(ctx);
			const klass = classifyContext(ctx);

			try {
				// Gate Class A on storage location; Class B/C on non-empty content
				// and COMPLETED extraction status (best-effort — the query does not
				// return extractionStatus for Class B free-text, but we honour it
				// for anything that does have it).
				if (klass === "A") {
					if (!ctx.s3Path) {
						skipped.push({
							type: ctx.type,
							title,
							reason: "Source object not found in storage",
						});
						continue;
					}
					if (
						ctx.extractionStatus &&
						ctx.extractionStatus !== "COMPLETED"
					) {
						// Still allow the raw bytes to flow — extraction status only
						// gates text extraction, not the original file.
					}
				} else {
					// Class B/C — content must be present.
					if (!ctx.content || ctx.content.length === 0) {
						skipped.push({
							type: ctx.type,
							title,
							reason: "Content unavailable",
						});
						continue;
					}
					if (
						ctx.extractionStatus &&
						ctx.extractionStatus !== "COMPLETED" &&
						ctx.extractionStatus !== "NOT_APPLICABLE"
					) {
						skipped.push({
							type: ctx.type,
							title,
							reason: "Context not ready",
						});
						continue;
					}
				}

				const baseName = contextDownloadFilename({
					title,
					class: klass,
					originalFilename: ctx.originalFilename,
					mimeType: ctx.mimeType,
					integration,
				});
				const finalName = dedupeFilename(seenNames, baseName);
				const subfolder = resolveSubfolder(
					klass,
					ctx.type,
					integration,
				);
				const entryPath = `${subfolder}/${finalName}`;

				if (klass === "A") {
					const srcBucket = ctx.s3Bucket ?? bucket;
					// biome-ignore lint/style/noNonNullAssertion: guarded above.
					const body = await getObjectStream(ctx.s3Path!, {
						bucket: srcBucket,
					});
					archive.append(body, { name: entryPath });
				} else {
					const payload = buildContextTextPayload({
						id: ctx.id,
						title,
						type: ctx.type,
						integrationProvider: integration,
						createdAt: ctx.createdAt,
						content: ctx.content ?? "",
					});
					archive.append(
						Readable.from(Buffer.from(payload, "utf8")),
						{
							name: entryPath,
						},
					);
				}

				included.push({
					type: ctx.type,
					title,
					fileInZip: entryPath,
				});
			} catch (err) {
				logger.warn(
					{ err, contextId: ctx.id },
					"context batch-download skipped",
				);
				skipped.push({
					type: ctx.type,
					title,
					reason: mapErrorToSkipReason(err),
				});
			}
		}

		// 6. Always append MANIFEST last so it reflects the final SKIPPED list.
		const manifest = buildContextDownloadManifest({
			project: { id: project.id, name: project.name },
			tenant: organizationId
				? { kind: "org", id: organizationId, name: project.name }
				: { kind: "personal" },
			exportedAt: now,
			exportedBy: {
				id: user.id,
				email: (user as { email?: string }).email ?? "",
			},
			included,
			skipped,
			totalBytes,
		});
		archive.append(manifest, { name: "MANIFEST.txt" });

		// 7. Finalize archive and await upload. `finalize()` resolves when
		//    archiver has flushed its last bytes into the PassThrough; the
		//    upload promise resolves when lib-storage has acked the final part.
		await archive.finalize();
		await uploadPromise;

		if (fatalError) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to build context archive",
			});
		}

		// 8. Presign a GET URL for the uploaded ZIP. Force the browser to save
		//    as `filename` (not the UUID S3 key) via Response* overrides —
		//    `anchor.download` is ignored for cross-origin URLs.
		const url = await getSignedUrl(key, {
			bucket,
			expiresIn: BATCH_PRESIGN_EXPIRY_SECONDS,
			responseContentDisposition: `attachment; filename="${filename}"`,
			responseContentType: "application/zip",
		});
		const expiresAt = new Date(
			now.getTime() + BATCH_PRESIGN_EXPIRY_SECONDS * 1000,
		).toISOString();

		return {
			url,
			filename,
			expiresAt,
			includedCount: included.length,
			skippedCount: skipped.length,
			totalCount,
			key,
		};
	});
