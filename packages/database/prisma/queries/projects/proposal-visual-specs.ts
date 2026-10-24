/**
 * The specs behind a Proposal's generated visuals (Fizzy #2946).
 *
 * A diagram the visuals step or Edit with instructions writes into Main
 * opens its fence with `%% fabric-visual: <id>`; each row keeps the
 * fact-checked spec it was drawn from, keyed by document, visual id and the
 * fence body's source hash (`@repo/utils/proposal-artifact/visual-identity`).
 * Rows are append-only: a duplicate insert is a no-op, so a retried write
 * changes nothing, and an older version's fence still finds its own row.
 *
 * The spec carries text derived from the section, so it never leaves the
 * server: `listProposalVisualSpecSummaries` is the read for clients and
 * returns ids, hashes, kind and origin only. Callers check the person's
 * access to the document before any read or write here.
 */

import {
	isVisualId,
	isVisualOrigin,
	VISUAL_HASH_PATTERN,
	type VisualOrigin,
	type VisualSpecSummary,
	visualSpecHash,
} from "@repo/utils/proposal-artifact/visual-identity";
import { db, type Prisma } from "../../client";

/** The write named a document outside the given project or organization. */
export class ProposalVisualSpecTenantError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProposalVisualSpecTenantError";
	}
}

const KIND = /^[a-z_]{1,32}$/;

export interface AppendProposalVisualSpecInput {
	organizationId: string;
	projectId: string;
	documentId: string;
	visualId: string;
	sourceHash: string;
	kind: string;
	origin: VisualOrigin;
	spec: Prisma.InputJsonValue;
	createdById?: string | null;
}

/**
 * Store one visual's spec unless the same (document, visual id, source hash)
 * is already stored. The document must belong to `projectId`, and the
 * project to `organizationId`. Returns whether a row was written.
 */
export async function appendProposalVisualSpec(
	input: AppendProposalVisualSpecInput,
): Promise<{ created: boolean }> {
	if (
		!isVisualId(input.visualId) ||
		!VISUAL_HASH_PATTERN.test(input.sourceHash) ||
		!KIND.test(input.kind) ||
		!isVisualOrigin(input.origin)
	) {
		throw new Error("The visual spec has an unknown shape");
	}
	const document = await db.projectDocument.findUnique({
		where: { id: input.documentId },
		select: {
			projectId: true,
			project: { select: { organizationId: true } },
		},
	});
	if (
		!document ||
		document.projectId !== input.projectId ||
		document.project?.organizationId !== input.organizationId
	) {
		throw new ProposalVisualSpecTenantError(
			"The document is not in this project and organization",
		);
	}

	// ON CONFLICT DO NOTHING on the unique key: the same visual written
	// twice leaves the first row as it was.
	const { count } = await db.projectDocumentVisualSpec.createMany({
		data: [
			{
				organizationId: input.organizationId,
				projectId: input.projectId,
				documentId: input.documentId,
				visualId: input.visualId,
				sourceHash: input.sourceHash,
				specHash: visualSpecHash(input.spec),
				kind: input.kind,
				origin: input.origin,
				spec: input.spec,
				createdById: input.createdById ?? null,
			},
		],
		skipDuplicates: true,
	});
	return { created: count > 0 };
}

const SPEC_SELECT = {
	visualId: true,
	sourceHash: true,
	specHash: true,
	kind: true,
	origin: true,
	spec: true,
	createdAt: true,
} as const;

export interface ProposalVisualSpecRecord {
	visualId: string;
	sourceHash: string;
	specHash: string;
	kind: string;
	origin: VisualOrigin;
	spec: Prisma.JsonValue;
	createdAt: Date;
}

function toRecord(row: {
	visualId: string;
	sourceHash: string;
	specHash: string;
	kind: string;
	origin: string;
	spec: Prisma.JsonValue;
	createdAt: Date;
}): ProposalVisualSpecRecord {
	return { ...row, origin: row.origin as VisualOrigin };
}

/** The newest spec stored for one visual of a document, or null. Server only. */
export async function getLatestProposalVisualSpec(input: {
	projectId: string;
	documentId: string;
	visualId: string;
}): Promise<ProposalVisualSpecRecord | null> {
	const row = await db.projectDocumentVisualSpec.findFirst({
		where: {
			projectId: input.projectId,
			documentId: input.documentId,
			visualId: input.visualId,
		},
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		select: SPEC_SELECT,
	});
	return row ? toRecord(row) : null;
}

/** The spec a fence with this id and source hash was drawn from, or null. Server only. */
export async function findProposalVisualSpecBySourceHash(input: {
	projectId: string;
	documentId: string;
	visualId: string;
	sourceHash: string;
}): Promise<ProposalVisualSpecRecord | null> {
	const row = await db.projectDocumentVisualSpec.findFirst({
		where: {
			projectId: input.projectId,
			documentId: input.documentId,
			visualId: input.visualId,
			sourceHash: input.sourceHash,
		},
		select: SPEC_SELECT,
	});
	return row ? toRecord(row) : null;
}

/**
 * Every stored visual of a document as a client may see it: ids, hashes,
 * kind and origin, never the spec. The input to `classifyVisualFences`.
 */
export async function listProposalVisualSpecSummaries(input: {
	organizationId: string;
	projectId: string;
	documentId: string;
}): Promise<VisualSpecSummary[]> {
	const rows = await db.projectDocumentVisualSpec.findMany({
		where: {
			organizationId: input.organizationId,
			projectId: input.projectId,
			documentId: input.documentId,
		},
		orderBy: [{ createdAt: "asc" }, { id: "asc" }],
		select: { visualId: true, sourceHash: true, kind: true, origin: true },
	});
	return rows.map((row) => ({ ...row, origin: row.origin as VisualOrigin }));
}
