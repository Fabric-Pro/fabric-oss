/**
 * Evaluation result cache utilities.
 */

import { createHash } from "node:crypto";
import { db } from "@repo/database";
import { subDays } from "date-fns";

const CACHE_VALIDITY_DAYS = 7;

export function generateContentHash(content: string): string {
	return createHash("sha256")
		.update(content.trim())
		.digest("hex")
		.slice(0, 32);
}

export async function getCachedEval(params: {
	projectDocumentId: string;
	contentHash: string;
	evalVersion: number;
	userId: string;
	organizationId?: string;
}) {
	const {
		projectDocumentId,
		contentHash,
		evalVersion,
		userId,
		organizationId,
	} = params;

	// SECURITY: Validate projectDocument ownership via project relationship
	// Defense-in-depth: Ensure the document's project belongs to this tenant
	return db.documentEval.findFirst({
		where: {
			projectDocumentId,
			contentHash,
			evalVersion,
			userId,
			organizationId: organizationId ?? null,
			// Validate document ownership by checking project tenant
			projectDocument: {
				project: {
					...(organizationId
						? { organizationId }
						: { userId, organizationId: null }),
				},
			},
			createdAt: {
				gte: subDays(new Date(), CACHE_VALIDITY_DAYS),
			},
		},
		include: {
			metrics: true,
			goldenReference: {
				select: { id: true, name: true, documentType: true },
			},
		},
		orderBy: { createdAt: "desc" },
	});
}
