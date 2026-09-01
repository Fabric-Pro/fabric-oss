import { ORPCError } from "@orpc/client";
import {
	adoptDocumentIntoProjectTenant,
	getDocumentById,
	hasProjectAccess,
} from "@repo/database";

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

	// Resolved early so the orphan branch below can use it. Asking sooner is not
	// answering sooner: FORBIDDEN is still thrown strictly after the tenant gate,
	// so an outsider who guessed the id still learns nothing from the ordering.
	const hasAccess = await hasProjectAccess(projectId, userId, organizationId);

	// A document with a null organization inside an org-owned project cannot
	// clear the gate below for ANYONE, its own members included — which is how
	// this arrived: an auto-refresh control that rendered and then reported the
	// document missing (Fizzy #2210). Adopt it into its project's tenant.
	//
	// Gated on project membership so an outsider cannot provoke a write by
	// guessing an id, and the refusal is NOT_FOUND rather than FORBIDDEN so the
	// orphan case stays exactly as uninformative as the healthy one.
	let documentOrganizationId = document.organizationId;
	if (documentOrganizationId === null) {
		if (!hasAccess) {
			throw notFound;
		}
		documentOrganizationId = await adoptDocumentIntoProjectTenant(document);
	}

	if ((documentOrganizationId ?? null) !== (organizationId ?? null)) {
		throw notFound;
	}

	if (!hasAccess) {
		throw new ORPCError("FORBIDDEN", {
			message: "You don't have access to this project",
		});
	}

	// The healed value, not the stale one the row was read with — the caller
	// copies this straight into the settings row's own tenant columns.
	return { ...document, organizationId: documentOrganizationId };
}
