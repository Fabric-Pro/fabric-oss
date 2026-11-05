import {
	hasPermission,
	Permissions,
	resolveOrgPermissions,
} from "@repo/permissions";
import {
	createOrganizationContext,
	runWithTenantContext,
} from "../../../src/tenant-context";
import { withRLSContext } from "../../../src/tenant-db";
import {
	createWorkspaceDocumentContentReader,
	type WorkspaceDocumentContentActor,
	WorkspaceDocumentContentError,
	type WorkspaceDocumentPageRow,
	workspaceDocumentActorSchema,
	workspaceDocumentCatalogInputSchema,
} from "../../../src/workspace-document-content";
import { db, Prisma } from "../../client";
import { listWorkspaceDocuments } from "./documents";
import { getWorkspaceAccessContext } from "./workspaces";

export * from "../../../src/workspace-document-content";

export async function authorizeWorkspaceDocumentRead(
	{
		workspaceId,
		userId,
		organizationId,
	}: WorkspaceDocumentContentActor & { workspaceId: string },
	client: Prisma.TransactionClient = db,
) {
	if (
		!workspaceDocumentActorSchema.safeParse({ userId, organizationId })
			.success ||
		!workspaceDocumentCatalogInputSchema.safeParse({ workspaceId }).success
	) {
		throw new WorkspaceDocumentContentError("INVALID_INPUT");
	}
	const access = await getWorkspaceAccessContext(
		workspaceId,
		userId,
		undefined,
		client,
	);
	if (access?.organizationId !== organizationId) {
		throw new WorkspaceDocumentContentError("NOT_FOUND");
	}
	const member = await client.member.findFirst({
		where: { userId, organizationId, organization: { deletedAt: null } },
		select: { role: true },
	});
	if (!member) {
		throw new WorkspaceDocumentContentError("NOT_FOUND");
	}
	if (
		!hasPermission(
			resolveOrgPermissions(member.role),
			Permissions.WORKSPACE_READ,
		)
	) {
		throw new WorkspaceDocumentContentError("FORBIDDEN");
	}
}

/** SQL returns only a bounded code-point page; source text is never loaded wholesale into Node. */
export function createBoundWorkspaceDocumentContentReader(
	client?: Prisma.TransactionClient,
) {
	return createWorkspaceDocumentContentReader({
		authorize: (scope) => authorizeWorkspaceDocumentRead(scope, client),
		async readPage(input) {
			const read = async (tx: Prisma.TransactionClient) => {
				const rows = await tx.$queryRaw<
					WorkspaceDocumentPageRow[]
				>(Prisma.sql`
				SELECT d.id, d."workspaceId", d."originalFilename" AS filename, d."mimeType", d.status::text,
					CASE WHEN d.status = 'READY' THEN substring(d."extractedText" FROM ${input.offset + 1}::integer FOR ${input.limit}::integer) END AS text,
					CASE WHEN d.status = 'READY' THEN encode(sha256(convert_to(d."extractedText", 'UTF8')), 'hex') END AS revision,
					char_length(d."extractedText") AS "totalCharacters", octet_length(d."extractedText") AS "totalBytes"
				FROM workspace_document d JOIN workspace w ON w.id = d."workspaceId"
				JOIN organization o ON o.id = w."organizationId"
				WHERE d.id = ${input.documentId} AND d."workspaceId" = ${input.workspaceId}
					AND w."organizationId" = ${input.organizationId} AND o."deletedAt" IS NULL
				LIMIT 1
			`);
				return rows[0] ?? null;
			};
			if (client) {
				return read(client);
			}
			return runWithTenantContext(
				createOrganizationContext(input.organizationId, input.userId),
				() => withRLSContext(db, read),
			);
		},
	});
}
export const readWorkspaceDocumentContent =
	createBoundWorkspaceDocumentContentReader();

/** Bounded live-offset metadata discovery, not a cross-page snapshot. Never load full extraction text. */
export async function getWorkspaceDocumentCatalog(
	actor: WorkspaceDocumentContentActor,
	raw: unknown,
) {
	const parsed = workspaceDocumentCatalogInputSchema.safeParse(raw);
	if (!parsed.success) {
		throw new WorkspaceDocumentContentError("INVALID_INPUT");
	}
	const { workspaceId, offset, limit } = parsed.data;
	const scope = { ...actor, workspaceId };
	await authorizeWorkspaceDocumentRead(scope);
	const workspace = await db.workspace.findFirst({
		where: { id: workspaceId, organizationId: actor.organizationId },
		select: {
			id: true,
			name: true,
			description: true,
			status: true,
			type: true,
			createdAt: true,
			updatedAt: true,
		},
	});
	if (!workspace) {
		throw new WorkspaceDocumentContentError("NOT_FOUND");
	}
	const page = await listWorkspaceDocuments({ workspaceId, offset, limit });
	await authorizeWorkspaceDocumentRead(scope);
	return {
		...workspace,
		documents: page.documents.map((document) => ({
			id: document.id,
			filename: document.originalFilename,
			mimeType: document.mimeType,
			size: document.size,
			status: document.status,
			chunkCount: document.chunkCount,
			updatedAt: document.updatedAt,
		})),
		documentCount: page.total,
		offset,
		limit,
		nextOffset: page.nextOffset ?? null,
		hasMore: page.hasMore,
		paginationMode: "live_offset" as const,
		snapshotConsistent: false as const,
	};
}
