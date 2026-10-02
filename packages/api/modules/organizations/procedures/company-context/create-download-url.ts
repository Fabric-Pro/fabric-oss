import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { config } from "@repo/config";
import {
	type CompanyContextSourceRecord,
	companyContextStoragePrefix,
	db,
} from "@repo/database";
import { getSignedUrl, uploadFile } from "@repo/storage";
import { buildContentDisposition } from "@repo/utils/attachment";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { buildContextTextPayload } from "../../../projects/lib/build-context-text-payload";
import { classifyContext } from "../../../projects/lib/context-classification";
import { contextDownloadFilename } from "../../../projects/lib/context-download-filename";
import { contextAuditResourceName } from "../../../projects/lib/context-metadata-audit";
import { joinCrawledPagesMarkdown } from "../../../projects/lib/path-prefix-link-markdown";
import { SINGLE_PRESIGN_EXPIRY_SECONDS } from "../../../projects/procedures/contexts/constants";
import {
	assertCompanyContextReader,
	loadCompanyContextSource,
} from "./lib/access";

/**
 * A website source's text: its crawled pages joined in reading order, as a
 * project website downloads, or the text on the row when it has no pages.
 */
async function companySourceText(
	source: CompanyContextSourceRecord,
	organizationId: string,
): Promise<string> {
	if (source.type !== "LINK") {
		return source.content;
	}
	const pages = await db.companyContextUrlPage.findMany({
		where: { parentSourceId: source.id, organizationId },
		select: { pageUrl: true, pageTitle: true, content: true },
		orderBy: { pageUrl: "asc" },
	});
	return pages.length > 0 ? joinCrawledPagesMarkdown(pages) : source.content;
}

/**
 * A short-lived download URL for one company context source (Fizzy #2719)
 * — the company twin of `projects.contexts.createDownloadUrl`, in the
 * same shape. Any member may download: the page is read-only for members, not
 * hidden from them.
 *
 * - A file presigns its stored object, and only from under the organization's
 *   own company-context prefix.
 * - A text or website is written out as the same Markdown export a project
 *   source produces, staged under that prefix — which organization deletion
 *   sweeps — and presigned.
 *
 * AUTHORIZATION: `ORG_READ` against the requested organization, membership of
 * it, then the company context gate. The source is loaded by
 * `(id, organizationId)`.
 */
export const createCompanyContextDownloadUrlProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/organizations/{organizationId}/company-context/{sourceId}/download-url",
		tags: ["Organizations", "Company context"],
		summary: "Create a company context download URL",
		description:
			"A short-lived URL to download one company context source: the uploaded file, or a Markdown export of a text or website.",
	})
	.input(
		z.object({
			organizationId: z.string().min(1),
			sourceId: z.string().min(1),
		}),
	)
	.handler(async ({ context: { user }, input }) => {
		const { organizationId, sourceId } = input;
		await assertCompanyContextReader(organizationId, user.id);

		const source = await loadCompanyContextSource(sourceId, organizationId);
		const storagePrefix = companyContextStoragePrefix(organizationId);
		const contextClass = classifyContext({ type: source.type });
		const expiresAt = new Date(
			Date.now() + SINGLE_PRESIGN_EXPIRY_SECONDS * 1000,
		).toISOString();

		if (contextClass === "A") {
			// Defense in depth: only a key this organization's company context
			// owns is ever signed.
			if (!source.s3Path?.startsWith(storagePrefix)) {
				throw new ORPCError("BAD_REQUEST", {
					message: "This source has no stored file to download",
					data: { code: "CONTENT_UNAVAILABLE" },
				});
			}
			const filename =
				source.originalFilename ||
				contextDownloadFilename({
					title: contextAuditResourceName(source),
					class: "A",
					originalFilename: source.originalFilename,
					mimeType: source.mimeType,
				});
			let url: string;
			try {
				url = await getSignedUrl(source.s3Path, {
					bucket:
						source.s3Bucket ??
						config.storage.bucketNames.projectContexts,
					expiresIn: SINGLE_PRESIGN_EXPIRY_SECONDS,
					responseContentDisposition:
						buildContentDisposition(filename),
					responseContentType: source.mimeType ?? undefined,
				});
			} catch (err) {
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message: "Failed to generate download URL",
					cause: err,
				});
			}
			return { url, filename, expiresAt, contextClass: "A" as const };
		}

		const content = await companySourceText(source, organizationId);
		if (!content) {
			throw new ORPCError("BAD_REQUEST", {
				message: "This source has no content to download",
				data: { code: "CONTENT_UNAVAILABLE" },
			});
		}

		const title = contextAuditResourceName(source);
		const payload = buildContextTextPayload({
			id: source.id,
			title,
			type: source.type,
			createdAt: source.createdAt,
			content,
		});
		const filename = contextDownloadFilename({
			title,
			class: contextClass,
		});
		const extension = contextClass === "B" ? "md" : "txt";
		const contentType = `${contextClass === "B" ? "text/markdown" : "text/plain"}; charset=utf-8`;
		const key = `${storagePrefix}downloads/${randomUUID()}.${extension}`;
		const bucket = config.storage.bucketNames.projectContexts;

		try {
			await uploadFile(key, Buffer.from(payload, "utf8"), {
				bucket,
				contentType,
				access: "private",
			});
		} catch (err) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to stage the source's text for download",
				cause: err,
			});
		}

		let url: string;
		try {
			url = await getSignedUrl(key, {
				bucket,
				expiresIn: SINGLE_PRESIGN_EXPIRY_SECONDS,
				responseContentDisposition: buildContentDisposition(filename),
				responseContentType: contentType,
			});
		} catch (err) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to generate download URL",
				cause: err,
			});
		}

		return { url, filename, expiresAt, contextClass };
	});
