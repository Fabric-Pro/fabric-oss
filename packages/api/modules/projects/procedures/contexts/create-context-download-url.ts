/**
 * oRPC procedure: `projects.contexts.createDownloadUrl`.
 *
 * Generates a short-lived presigned URL so the caller can download a single
 * project context, regardless of its class:
 *
 *   - Class A (`FILE` / `IMAGE` / `DOCUMENT` / `SPREADSHEET`) — presign the
 *     original S3 object directly.
 *   - Class B (`TEXT` / planning-surface aliases) — synthesize a `.md`
 *     payload (shared header + `content`) and upload to a per-request temp
 *     key under `downloads/project-contexts/{projectId}/single/`.
 *   - Class C (`LINK` / `INTEGRATION` / `MEETING_TRANSCRIPT` / `CODE_FILE` /
 *     `CODE_FILE_SUMMARY`) — synthesize a `.txt` payload the same way.
 *
 * Spec: `docs/specs/2026-04-15-download-project-context-files/spec.md` §6.1,
 * §8.2, §8.4, §10. TDD backing tests live in
 * `./__tests__/create-context-download-url.test.ts`.
 *
 * Auth & tenant checks mirror spec §6.1:
 *   1. `tenantProtectedProcedure` resolves user + session.
 *   2. `resolveOrganizationId` collapses the nullable input to the effective
 *      tenant id (`null` for personal).
 *   3. If org-scoped, `verifyOrganizationMembership` must return a non-null
 *      active membership — otherwise `FORBIDDEN`.
 *   4. `getContextById(contextId, projectId, tenant)` enforces the XOR filter
 *      plus a defense-in-depth `projectId` equality check.
 *
 * Storage access goes through `@repo/storage` — this module intentionally
 * never imports `@aws-sdk/*` directly.
 */

import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { config } from "@repo/config";
import { getContextById } from "@repo/database";
import { getSignedUrl, uploadFile } from "@repo/storage";
import { buildContentDisposition } from "@repo/utils/attachment";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";
import { buildContextTextPayload } from "../../lib/build-context-text-payload";
import { classifyContext } from "../../lib/context-classification";
import { contextDownloadFilename } from "../../lib/context-download-filename";
import {
	buildPathPrefixMarkdown,
	isPathPrefixLink,
} from "../../lib/path-prefix-link-markdown";
import { SINGLE_PRESIGN_EXPIRY_SECONDS } from "./constants";

/** Input schema — spec §6.1. */
const createContextDownloadUrlInput = z.object({
	contextId: z.string().min(1),
	projectId: z.string().min(1),
	organizationId: z.string().nullable().optional(),
});

/**
 * Shape the loose `metadata` JSON value on a `ProjectContext` row into a
 * plain record so we can pull the integration provider + title fields
 * without leaking `any` through the handler body.
 */
function readMetadataRecord(metadata: unknown): Record<string, unknown> {
	if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
		return metadata as Record<string, unknown>;
	}
	return {};
}

/** Extract the integration provider tag from either the dedicated column or `metadata.provider`. */
function readIntegrationProvider(ctx: {
	integrationProvider?: string | null;
	metadata?: unknown;
}): string | null {
	if (ctx.integrationProvider) {
		return ctx.integrationProvider;
	}
	const meta = readMetadataRecord(ctx.metadata);
	const provider = meta.provider;
	return typeof provider === "string" && provider.length > 0
		? provider
		: null;
}

/** Resolve a human-readable title from column + metadata fallbacks. */
function readContextTitle(ctx: {
	sourceTitle?: string | null;
	originalFilename?: string | null;
	metadata?: unknown;
}): string {
	if (ctx.sourceTitle && ctx.sourceTitle.length > 0) {
		return ctx.sourceTitle;
	}
	const meta = readMetadataRecord(ctx.metadata);
	const metaTitle = meta.title ?? meta.documentTitle ?? meta.sourceTitle;
	if (typeof metaTitle === "string" && metaTitle.length > 0) {
		return metaTitle;
	}
	if (ctx.originalFilename && ctx.originalFilename.length > 0) {
		return ctx.originalFilename;
	}
	return "context";
}

export const createContextDownloadUrlProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.CONTEXT_READ))
	.route({
		method: "POST",
		path: "/projects/:projectId/contexts/:contextId/download-url",
		tags: ["Projects", "Contexts"],
		summary: "Create context download URL",
		description:
			"Generate a short-lived presigned URL to download a single project context, synthesizing a text payload for non-binary classes when needed.",
	})
	.input(createContextDownloadUrlInput)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Spec §6.1 step 3 — explicit org membership guard on top of XOR.
		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				user.id,
			);
			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message:
						"You are not an active member of this organization",
				});
			}
		}

		// Spec §6.1 step 4 — scoped lookup with tenant XOR + projectId equality.
		const projectContext = await getContextById(
			input.contextId,
			input.projectId,
			{ userId: user.id, organizationId: organizationId ?? null },
		);

		if (!projectContext) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project context not found",
			});
		}

		const contextClass = classifyContext({ type: projectContext.type });
		const expiresAt = new Date(
			Date.now() + SINGLE_PRESIGN_EXPIRY_SECONDS * 1000,
		).toISOString();

		if (contextClass === "A") {
			const s3Path = projectContext.s3Path;
			if (!s3Path || s3Path.length === 0) {
				throw new ORPCError("BAD_REQUEST", {
					message: "This context has no stored file to download",
					data: { code: "CONTENT_UNAVAILABLE" },
				});
			}

			const bucket =
				projectContext.s3Bucket ??
				config.storage.bucketNames.projectContexts;

			const title = readContextTitle(projectContext);
			const filename =
				projectContext.originalFilename &&
				projectContext.originalFilename.length > 0
					? projectContext.originalFilename
					: contextDownloadFilename({
							title,
							class: "A",
							originalFilename:
								projectContext.originalFilename ?? null,
							mimeType: projectContext.mimeType ?? null,
						});

			let url: string;
			try {
				url = await getSignedUrl(s3Path, {
					bucket,
					expiresIn: SINGLE_PRESIGN_EXPIRY_SECONDS,
					responseContentDisposition:
						buildContentDisposition(filename),
					responseContentType: projectContext.mimeType ?? undefined,
				});
			} catch (err) {
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message: "Failed to generate download URL",
					cause: err,
				});
			}

			return {
				url,
				filename,
				expiresAt,
				contextClass: "A" as const,
			};
		}

		// Class B / C — synthesize payload, upload to a per-request temp key,
		// and presign a GET. Spec §6.1, §8.2.
		//
		// URL Context Sources branch: LINK rows with `urlScope === "PATH_PREFIX"`
		// don't carry their markdown on `parent.content`. The crawl scatters it
		// across `ProjectContextUrlPage` rows so the drawer doesn't have to
		// stream 500 × 50 KB blobs on first paint. For the download we
		// concatenate the children in-place (ordered by pageUrl ASC) so the
		// presigned `.md` is one self-contained Markdown file.
		let content = projectContext.content;
		if (isPathPrefixLink(projectContext)) {
			const tenantFilter = organizationId
				? { organizationId }
				: { organizationId: null as null, userId: user.id };
			content = await buildPathPrefixMarkdown(
				projectContext.id,
				tenantFilter,
			);
		}
		if (!content || content.length === 0) {
			throw new ORPCError("BAD_REQUEST", {
				message: "This context has no content to download",
				data: { code: "CONTENT_UNAVAILABLE" },
			});
		}

		const title = readContextTitle(projectContext);
		const integrationProvider = readIntegrationProvider(projectContext);

		const payload = buildContextTextPayload({
			id: projectContext.id,
			title,
			type: projectContext.type,
			integrationProvider,
			createdAt: projectContext.createdAt,
			content,
		});

		const filename = contextDownloadFilename({
			title,
			class: contextClass,
			integration: integrationProvider,
		});

		const extension = contextClass === "B" ? "md" : "txt";
		const contentType =
			contextClass === "B" ? "text/markdown" : "text/plain";
		const key = `downloads/project-contexts/${input.projectId}/single/${randomUUID()}.${extension}`;
		const bucket = config.storage.bucketNames.projectContexts;
		const body = Buffer.from(payload, "utf8");

		try {
			await uploadFile(key, body, {
				bucket,
				contentType: `${contentType}; charset=utf-8`,
				access: "private",
			});
		} catch (err) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to stage synthesized context payload",
				cause: err,
			});
		}

		let url: string;
		try {
			url = await getSignedUrl(key, {
				bucket,
				expiresIn: SINGLE_PRESIGN_EXPIRY_SECONDS,
				responseContentDisposition: buildContentDisposition(filename),
				responseContentType: `${contentType}; charset=utf-8`,
			});
		} catch (err) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to generate download URL",
				cause: err,
			});
		}

		return {
			url,
			filename,
			expiresAt,
			contextClass,
		};
	});
