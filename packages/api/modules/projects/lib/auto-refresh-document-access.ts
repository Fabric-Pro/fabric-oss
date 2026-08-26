import { ORPCError } from "@orpc/client";
import { getDocumentById, hasProjectAccess } from "@repo/database";

type LoadedDocument = NonNullable<Awaited<ReturnType<typeof getDocumentById>>>;

/**
 * Shared authorization preamble for the auto-refresh enrollment procedures.
 *
 * Mirrors `update-with-context.ts` (hasProjectAccess + document lookup +
 * NOT_FOUND when the document isn't in the project) with one deliberate
 * difference in ORDER: `getDocumentById` is an UNSCOPED `findUnique({ id })`,
 * so the tenant-equality gate — not `hasProjectAccess` — is the isolation
 * boundary and has to run first.
 *
 * A caller whose resolved tenant doesn't match the document's gets NOT_FOUND,
 * never FORBIDDEN: replying FORBIDDEN would confirm the document exists to an
 * outsider who guessed the id (the existence-oracle trap in
 * `docs/solutions/architecture-patterns/cancelling-temporal-backed-jobs.md` §3).
 * FORBIDDEN is reserved for callers who ARE in the tenant but lack access to
 * this project.
 *
 * Both helpers are shared rather than copy-pasted per procedure so the gate
 * cannot drift between the read and the write path.
 */
export async function loadDocumentForAutoRefresh(args: {
	documentId: string;
	projectId: string;
	userId: string;
	organizationId: string | undefined;
}): Promise<LoadedDocument> {
	const { documentId, projectId, userId, organizationId } = args;

	const document = await getDocumentById(documentId);

	// Tenant gate FIRST — before any access/role check. `null` (personal) and a
	// string (org) are compared exclusively: the repo's XOR rule, never an OR.
	const notFound = new ORPCError("NOT_FOUND", {
		message: "Document not found",
	});
	if (!document || document.projectId !== projectId) {
		throw notFound;
	}
	if ((document.organizationId ?? null) !== (organizationId ?? null)) {
		throw notFound;
	}

	const hasAccess = await hasProjectAccess(projectId, userId, organizationId);
	if (!hasAccess) {
		throw new ORPCError("FORBIDDEN", {
			message: "You don't have access to this project",
		});
	}

	return document;
}
