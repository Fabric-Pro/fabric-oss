/**
 * The brand a client-document Proposal's last export printed (Fizzy #2946):
 * one row per document holding the token hash of what the export printed, so
 * a later brand change can be told apart from the last export. Written only
 * by the export worker, after a successful upload; nothing reads it yet (the
 * "brand changed since last export" note waits on a product answer).
 */

import { randomUUID } from "node:crypto";
import { db } from "../../client";

export const PROPOSAL_EXPORT_BRAND_FORMATS = ["PDF", "DOCX"] as const;
export type ProposalExportBrandFormat =
	(typeof PROPOSAL_EXPORT_BRAND_FORMATS)[number];

const TOKEN_HASH = /^t[0-9]+:[0-9a-f]{16}$/;

/**
 * Record the export's brand unless a later-started export already did.
 * `exportedAt` is when the export read its brand, so of two overlapping
 * exports the one that read later wins whichever finishes last. One
 * statement, so the comparison and the write cannot be split by a concurrent
 * export. Returns whether the row was written.
 */
export async function recordProposalExportBrand(input: {
	documentId: string;
	projectId: string;
	organizationId: string;
	themeTokenHash: string;
	format: ProposalExportBrandFormat;
	exportedAt: Date;
}): Promise<boolean> {
	if (!TOKEN_HASH.test(input.themeTokenHash)) {
		throw new Error("The export's token hash has an unknown shape");
	}
	const written = await db.$executeRaw`
		INSERT INTO "project_document_export_brand"
			("id", "documentId", "projectId", "organizationId", "themeTokenHash",
			 "format", "exportedAt", "createdAt", "updatedAt")
		VALUES (${randomUUID()}, ${input.documentId}, ${input.projectId},
			${input.organizationId}, ${input.themeTokenHash}, ${input.format},
			${input.exportedAt}::timestamp, (now() AT TIME ZONE 'UTC'),
			(now() AT TIME ZONE 'UTC'))
		ON CONFLICT ("documentId") DO UPDATE SET
			"projectId" = excluded."projectId",
			"organizationId" = excluded."organizationId",
			"themeTokenHash" = excluded."themeTokenHash",
			"format" = excluded."format",
			"exportedAt" = excluded."exportedAt",
			"updatedAt" = excluded."updatedAt"
		WHERE excluded."exportedAt" >= "project_document_export_brand"."exportedAt"`;
	return written > 0;
}
