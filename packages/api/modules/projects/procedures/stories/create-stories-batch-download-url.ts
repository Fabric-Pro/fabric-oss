/**
 * `projects.stories.createBatchDownloadUrl` — stream the selected features for
 * a project into a single ZIP of `*.md` files plus a `MANIFEST.txt`, then
 * return a presigned GET URL.
 *
 * Mirrors the streaming / S3 / manifest pattern of
 * `packages/api/modules/projects/procedures/contexts/create-contexts-batch-download-url.ts`
 * verbatim. Per spec §3.2 / D3 the bulk format inside the ZIP is **MD only**
 * for v1 — PDF/DOCX inside the bundle is a deferred follow-up.
 *
 * Streaming model:
 *   archiver (Readable) → putObjectStream (lib-storage Upload, multipart)
 *
 * Stub features and cross-tenant IDs are silently dropped from the included
 * set and recorded in the `MANIFEST.txt` SKIPPED block. If every selected
 * feature is filtered out we throw `BAD_REQUEST` with the i18n key
 * `projects.stories.download.empty` so the client surfaces a friendly toast.
 *
 * Tenant isolation: the `findMany` on `userStory` filters by `projectId`
 * AND `id IN storyIds`. The project-level permission has already been
 * validated by `requireProjectPermission`, so any feature belonging to a
 * different tenant naturally drops out and is recorded under
 * `NOT_FOUND_OR_NO_PERMISSION`.
 */

import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { ORPCError } from "@orpc/server";
import { config } from "@repo/config";
import { getProjectForDownload, listStoriesForDownload } from "@repo/database";
import { logger } from "@repo/logs";
import { getSignedUrl, putObjectStream } from "@repo/storage";
import archiver from "archiver";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";
import {
	buildStoryDownloadManifest,
	type StoryManifestIncludedRow,
	type StoryManifestSkippedRow,
} from "../../lib/story-download-manifest";
import {
	isStoryStub,
	serializeStoryToMarkdown,
	toStorySlug,
} from "../../lib/story-to-markdown";
import { BATCH_PRESIGN_EXPIRY_SECONDS } from "../contexts/constants";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Soft cap on features per bulk download — D3 in `decisions.md`. */
const MAX_BATCH_DOWNLOAD_STORIES = 50 as const;

// ---------------------------------------------------------------------------
// Zod input / output — spec §4.1
// ---------------------------------------------------------------------------

export const createStoriesBatchDownloadUrlInput = z.object({
	projectId: z.string().min(1),
	storyIds: z
		.array(z.string().min(1))
		.min(1)
		.max(MAX_BATCH_DOWNLOAD_STORIES)
		.refine((arr) => new Set(arr).size === arr.length, {
			message: "storyIds must be unique",
		}),
	organizationId: z.string().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Procedure
// ---------------------------------------------------------------------------

export const createStoriesBatchDownloadUrlProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/batch-download-url",
		tags: ["Projects", "Stories"],
		summary: "Create batch features ZIP download URL",
		description:
			"Stream the selected features into a ZIP of Markdown files plus a MANIFEST.txt and return a presigned GET URL. MD-only inside the ZIP per D3.",
	})
	.input(createStoriesBatchDownloadUrlInput)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Active-member check for org context. Personal context is implicit
		// via `organizationId = undefined`.
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

		// 1. Resolve the project under the tenant XOR filter.
		const project = await getProjectForDownload(input.projectId, tenant);
		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		// 2. Load the requested stories. The query filters by projectId AND
		// id IN storyIds, so cross-tenant rows naturally fall out.
		const stories = await listStoriesForDownload(
			input.projectId,
			input.storyIds,
		);

		// 3. Map by id for O(1) lookup, then walk the input order so the
		// manifest preserves the caller's selection order.
		const byId = new Map(stories.map((s) => [s.id, s]));

		const included: StoryManifestIncludedRow[] = [];
		const skipped: StoryManifestSkippedRow[] = [];
		const renderedFiles: { filename: string; markdown: string }[] = [];
		const seenNames = new Set<string>();

		const now = new Date();
		const generatedAt = now.toISOString();

		for (const storyId of input.storyIds) {
			const story = byId.get(storyId);
			if (!story) {
				skipped.push({
					storyId,
					identifier: null,
					reason: "NOT_FOUND_OR_NO_PERMISSION",
				});
				continue;
			}

			if (isStoryStub(story)) {
				skipped.push({
					storyId: story.id,
					identifier: story.identifier,
					reason: "INSUFFICIENT_CONTENT",
				});
				continue;
			}

			const baseName = `${toStorySlug(`${story.identifier}-${story.title}`)}.md`;
			let finalName = baseName;
			let collisionCounter = 1;
			while (seenNames.has(finalName)) {
				const dot = baseName.lastIndexOf(".");
				const stem = dot >= 0 ? baseName.slice(0, dot) : baseName;
				const ext = dot >= 0 ? baseName.slice(dot) : "";
				finalName = `${stem}-${collisionCounter}${ext}`;
				collisionCounter += 1;
			}
			seenNames.add(finalName);

			const markdown = serializeStoryToMarkdown(
				story,
				{ name: project.name },
				{ generatedAt },
			);
			renderedFiles.push({ filename: finalName, markdown });
			included.push({
				storyId: story.id,
				identifier: story.identifier,
				filename: finalName,
			});
		}

		// 4. Empty result guard — every requested feature was filtered out.
		if (included.length === 0) {
			throw new ORPCError("BAD_REQUEST", {
				message: "projects.stories.download.empty",
				data: {
					skippedCount: skipped.length,
					reason: skipped[0]?.reason ?? "INSUFFICIENT_CONTENT",
				},
			});
		}

		// 5. Build the output filenames / S3 key.
		const ulid = randomUUID();
		const outerFilename = `features-${ulid}.zip`;
		const key = `batch-downloads/stories/${input.projectId}/${ulid}.zip`;
		const bucket = config.storage.bucketNames.projectContexts;

		// 6. Stream archive → upload pipeline.
		const archive = archiver("zip", { zlib: { level: 9 } });
		const archiveOutput = new PassThrough();
		archive.pipe(archiveOutput);

		const uploadPromise = putObjectStream(key, archiveOutput, {
			bucket,
			contentType: "application/zip",
		});

		let fatalError: unknown = null;
		archive.on("error", (err) => {
			fatalError = err;
		});

		try {
			for (const file of renderedFiles) {
				archive.append(file.markdown, { name: file.filename });
			}

			const manifestPayload = buildStoryDownloadManifest({
				project: { id: project.id, name: project.name },
				exportedAt: now,
				exportedBy: {
					id: user.id,
					email: (user as { email?: string }).email ?? "",
				},
				included,
				skipped,
			});
			archive.append(manifestPayload, { name: "MANIFEST.txt" });

			await archive.finalize();
			await uploadPromise;
		} catch (err) {
			logger.error(
				{ err, projectId: input.projectId },
				"stories batch-download upload failed",
			);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to build features archive",
			});
		}

		if (fatalError) {
			logger.error(
				{ err: fatalError, projectId: input.projectId },
				"stories batch-download archiver error",
			);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to build features archive",
			});
		}

		// 7. Presign a GET URL for the uploaded ZIP, forcing the browser to
		// save under `outerFilename` (the UUID-derived stem stays out of the
		// URL path).
		const url = await getSignedUrl(key, {
			bucket,
			expiresIn: BATCH_PRESIGN_EXPIRY_SECONDS,
			responseContentDisposition: `attachment; filename="${outerFilename}"`,
			responseContentType: "application/zip",
		});
		const expiresAt = new Date(
			now.getTime() + BATCH_PRESIGN_EXPIRY_SECONDS * 1000,
		).toISOString();

		return {
			url,
			expiresAt,
			manifest: {
				included,
				skipped,
			},
		};
	});
