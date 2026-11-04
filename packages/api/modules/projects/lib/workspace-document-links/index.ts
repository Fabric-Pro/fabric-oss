import { hasPermission, Permissions } from "@repo/permissions";
import { resolveEffectiveProjectPermissions } from "@repo/rag/lib/context-quality/project-access";
import {
	createWorkspaceDocumentLinkCommands,
	type LinkedDocumentMetadata,
} from "./commands";
import { WorkspaceLinkError } from "./contracts";

export * from "./contracts";

/** Runtime imports stay behind a command call so tool-catalog discovery performs no I/O. */
export async function workspaceDocumentLinkCommands() {
	const {
		db,
		Prisma,
		hasProjectAccess,
		canEditProject,
		isProjectSoftDeleted,
		recordAuditTx,
	} = await import("@repo/database");
	const {
		authorizeWorkspaceDocumentRead,
		createBoundWorkspaceDocumentContentReader,
	} = await import(
		"@repo/database/prisma/queries/workspaces/document-content"
	);
	const { createOrganizationContext, runWithTenantContext } = await import(
		"@repo/database/src/tenant-context"
	);
	const { withRLSContext } = await import("@repo/database/src/tenant-db");
	type Actor = import("./contracts").WorkspaceLinkActor;
	const inScope = <T>(
		actor: Actor,
		fn: (
			tx: import("@repo/database").Prisma.TransactionClient,
		) => Promise<T>,
		client?: import("@repo/database").Prisma.TransactionClient,
	): Promise<T> =>
		client
			? fn(client)
			: runWithTenantContext(
					createOrganizationContext(
						actor.organizationId,
						actor.userId,
					),
					() => withRLSContext(db, fn),
				);
	return createWorkspaceDocumentLinkCommands({
		async authorizeProject(actor, operation, client) {
			const access = await resolveEffectiveProjectPermissions(
				actor.projectId,
				actor.userId,
				client,
			);
			if (
				!access ||
				access.organizationId !== actor.organizationId ||
				access.organizationDeleted ||
				!(await hasProjectAccess(
					actor.projectId,
					actor.userId,
					actor.organizationId,
					client,
				)) ||
				(await isProjectSoftDeleted(actor.projectId, client))
			) {
				throw new WorkspaceLinkError("NOT_FOUND");
			}
			const permission =
				operation === "read"
					? Permissions.CONTEXT_READ
					: operation === "link"
						? Permissions.CONTEXT_CREATE
						: Permissions.CONTEXT_DELETE;
			if (
				!hasPermission(access.permissions, permission) ||
				(operation !== "read" &&
					!(await canEditProject(
						actor.projectId,
						actor.userId,
						client,
					)))
			) {
				throw new WorkspaceLinkError("FORBIDDEN");
			}
		},
		authorizeWorkspace: (actor, workspaceId, client) =>
			authorizeWorkspaceDocumentRead({ ...actor, workspaceId }, client),
		async documents(actor, ids, client) {
			if (!ids.length) {
				return [];
			}
			return inScope(
				actor,
				(tx) =>
					tx.$queryRaw<LinkedDocumentMetadata[]>(Prisma.sql`
    SELECT d.id,d."workspaceId",w."organizationId",d."originalFilename" AS filename,w.name AS "workspaceName",d.status::text,d."updatedAt",
     CASE WHEN d.status='READY' THEN encode(sha256(convert_to(d."extractedText",'UTF8')),'hex') END AS revision
    FROM workspace_document d JOIN workspace w ON w.id=d."workspaceId"
    WHERE d.id IN (${Prisma.join(ids)}) AND w."organizationId"=${actor.organizationId}`),
				client,
			);
		},
		list: (actor, page) =>
			inScope(actor, (tx) =>
				tx.projectWorkspaceDocumentLink.findMany({
					where: {
						organizationId: actor.organizationId,
						projectId: actor.projectId,
					},
					orderBy: [{ createdAt: "desc" }, { id: "desc" }],
					skip: page.offset,
					take: page.limit,
				}),
			),
		get: (actor, id) =>
			inScope(actor, (tx) =>
				tx.projectWorkspaceDocumentLink.findFirst({
					where: {
						id,
						organizationId: actor.organizationId,
						projectId: actor.projectId,
					},
				}),
			),
		read: (actor, input, client) =>
			createBoundWorkspaceDocumentContentReader(client)(
				{ userId: actor.userId, organizationId: actor.organizationId },
				input,
			),
		add: (actor, input, validate, via) =>
			inScope(actor, async (tx) => {
				await validate(tx);
				const result = await tx.projectWorkspaceDocumentLink.createMany(
					{
						data: {
							organizationId: actor.organizationId,
							projectId: actor.projectId,
							documentId: input.documentId,
							addedByUserId: actor.userId,
							sourceRevisionAtLink: input.expectedRevision,
						},
						skipDuplicates: true,
					},
				);
				const link =
					await tx.projectWorkspaceDocumentLink.findFirstOrThrow({
						where: {
							organizationId: actor.organizationId,
							projectId: actor.projectId,
							documentId: input.documentId,
						},
						select: { id: true },
					});
				if (result.count) {
					await recordAuditTx(tx, {
						action: "project.context_source.workspace_document_linked",
						category: "project",
						organizationId: actor.organizationId,
						projectId: actor.projectId,
						actor: { type: via, userId: actor.userId },
						resource: { type: "project_context", id: link.id },
						metadata: {
							sourceRevision: input.expectedRevision,
							contentCopied: false,
							sharingGranted: false,
						},
					});
				}
				await validate(tx);
				return { linkId: link.id, created: result.count === 1 };
			}),
		remove: (actor, linkId, validate, via) =>
			inScope(actor, async (tx) => {
				await validate(tx);
				const result = await tx.projectWorkspaceDocumentLink.deleteMany(
					{
						where: {
							id: linkId,
							organizationId: actor.organizationId,
							projectId: actor.projectId,
						},
					},
				);
				if (result.count) {
					await recordAuditTx(tx, {
						action: "project.context_source.workspace_document_unlinked",
						category: "project",
						organizationId: actor.organizationId,
						projectId: actor.projectId,
						actor: { type: via, userId: actor.userId },
						resource: { type: "project_context", id: linkId },
						metadata: { originalDeleted: false },
					});
				}
				await validate(tx);
				return { removed: result.count === 1 };
			}),
	});
}
