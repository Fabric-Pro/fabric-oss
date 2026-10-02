/**
 * Who may read and who may change an organization's company context
 * (Fizzy #2719), and the by-id lookup every procedure shares.
 *
 * The chain copies the Brand kit's, never the project `CONTEXT_*` one: the
 * member role already holds `CONTEXT_CREATE/UPDATE/DELETE`, so reusing those
 * permissions would let every member edit material that steers every Proposal
 * in the organization.
 *
 * - Reads: `requireInputOrgPermission(ORG_READ, { requireOrganization: true })`
 *   in the procedure, then `assertCompanyContextReader` — membership of the
 *   INPUT organization, then the rollout gate.
 * - Writes: `requireInputOrgPermission(ORG_UPDATE, …)` in the procedure, then
 *   `assertCompanyContextEditor` — admin or owner of that organization, then
 *   the gate.
 *
 * A project guest has no `member` row in the organization, so both refuse
 * them. The organization is always the one the input names and the
 * middleware verified, never the session's.
 */

import { ORPCError } from "@orpc/server";
import {
	type CompanyContextSourceMetaRecord,
	type CompanyContextSourceRecord,
	getCompanyContextSource,
	getCompanyContextSourceMeta,
} from "@repo/database";
import { assertCompanyContextEnabled } from "../../../lib/company-context-feature";
import {
	requireOrgMembership,
	verifyOrganizationMembership,
} from "../../../lib/membership";
import { isCompanySourceInFlight } from "./source-state";

/** The organization roles that manage company context. */
const COMPANY_CONTEXT_EDITOR_ROLES = ["admin", "owner"] as const;

/** Any member of the organization, then the gate. */
export async function assertCompanyContextReader(
	organizationId: string,
	userId: string,
): Promise<void> {
	const membership = await verifyOrganizationMembership(
		organizationId,
		userId,
	);
	if (!membership) {
		throw new ORPCError("FORBIDDEN", {
			message: "You are not a member of this organization",
		});
	}
	await assertCompanyContextEnabled(organizationId);
}

/** An admin or owner of the organization, then the gate. */
export async function assertCompanyContextEditor(
	organizationId: string,
	userId: string,
): Promise<void> {
	const membership = await requireOrgMembership(userId, organizationId, [
		...COMPANY_CONTEXT_EDITOR_ROLES,
	]);
	if (!membership) {
		throw new ORPCError("FORBIDDEN", {
			message: "You must be an admin or owner of this organization",
		});
	}
	await assertCompanyContextEnabled(organizationId);
}

function foundOrThrow<T>(source: T | null): T {
	if (!source) {
		throw new ORPCError("NOT_FOUND", {
			message: "Company context source not found",
		});
	}
	return source;
}

/**
 * One source of the organization, content included, or NOT_FOUND. Loaded by
 * `(id, organizationId)`, so another organization's id reads exactly like an
 * id that names nothing.
 */
export async function loadCompanyContextSource(
	sourceId: string,
	organizationId: string,
): Promise<CompanyContextSourceRecord> {
	return foundOrThrow(
		await getCompanyContextSource(sourceId, organizationId),
	);
}

/**
 * `loadCompanyContextSource` without the content, for the procedures that
 * act on a source's state and never read its text. Same scoping, same
 * NOT_FOUND.
 */
export async function loadCompanyContextSourceMeta(
	sourceId: string,
	organizationId: string,
): Promise<CompanyContextSourceMetaRecord> {
	return foundOrThrow(
		await getCompanyContextSourceMeta(sourceId, organizationId),
	);
}

/**
 * True while a LINK source's crawl is queued or running — one the API started
 * (PENDING or EXTRACTING) or a scheduled refresh, which leaves the status
 * alone but holds the crawl slot. See `isCompanySourceInFlight`.
 */
export function isCrawlInFlight(source: {
	type: string;
	extractionStatus: string;
	urlActiveWorkflowId: string | null;
}): boolean {
	return source.type === "LINK" && isCompanySourceInFlight(source);
}
