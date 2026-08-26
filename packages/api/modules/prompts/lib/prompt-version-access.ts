import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

/**
 * Who is entitled to a prompt version's content.
 *
 * TENANT ISOLATION (SOC 2 CC6.1). Every one of these paths takes a version by
 * ID, so without a reachability check an ID is enough to pull another tenant's
 * prompt body into a place they can read it — cross-tenant content exposure,
 * and injection into whatever the bound prompt then drives.
 *
 * This lives in its own module because it was originally private to `bind.ts`
 * and the nomination path was written later without it. One shared
 * implementation is the point: a second write path must not be able to exist
 * without the check.
 *
 * Deliberately NOT the same rule as `assertVersionSuitsScope` in bind.ts. That
 * asks "is this content of a high enough tier to back this default?"; this asks
 * only "is this person entitled to this content at all?". Nomination exists
 * precisely to promote a lower-tier prompt upward, so it applies this check and
 * not that one.
 */

type ReachableVersion = {
	scope: string | null;
	userId: string | null;
	organizationId: string | null;
};

async function loadVersion(promptVersionId: string) {
	const pv = await db.promptVersion.findUnique({
		where: { id: promptVersionId },
		select: { scope: true, userId: true, organizationId: true },
	});
	if (!pv) {
		throw new ORPCError("NOT_FOUND", {
			message: "Prompt version not found",
		});
	}
	return pv as ReachableVersion;
}

/**
 * May this caller, acting in this tenant, use this version?
 *
 * SYSTEM content is readable by everyone; personal content only by its owner;
 * organization content only from inside that organization.
 */
export async function assertPromptVersionReachable({
	promptVersionId,
	organizationId,
	userId,
}: {
	promptVersionId: string;
	organizationId: string | null | undefined;
	userId: string;
}) {
	const pv = await loadVersion(promptVersionId);

	const accessible =
		pv.scope === "SYSTEM" ||
		(pv.scope === "USER" && pv.userId === userId) ||
		(pv.scope === "ORG" &&
			!!organizationId &&
			pv.organizationId === organizationId);

	if (!accessible) {
		throw new ORPCError("FORBIDDEN", {
			message: "You cannot use this prompt version",
		});
	}

	return pv;
}

/**
 * May this nomination's stored version still be bound?
 *
 * Checked again at approval, not only at creation, for three reasons: a row may
 * predate the creation-time check; approval happens later and by someone else;
 * and the nominator may have left the organization whose prompt they proposed
 * in the meantime. The reviewer's own access is not the question — they are
 * deciding about somebody else's proposal — so entitlement is re-derived from
 * the NOMINATOR.
 *
 * An organization-scoped version is resolved through live membership rather
 * than by comparing against the nomination's target organization: a prompt from
 * one organization may legitimately be proposed as the universal default, where
 * there is no target organization to compare with.
 */
export async function assertNominatedVersionReachable({
	promptVersionId,
	nominatedById,
}: {
	promptVersionId: string;
	nominatedById: string;
}) {
	const pv = await loadVersion(promptVersionId);

	if (pv.scope === "SYSTEM") {
		return pv;
	}

	if (pv.scope === "USER" && pv.userId === nominatedById) {
		return pv;
	}

	if (pv.scope === "ORG" && pv.organizationId) {
		const membership = await verifyOrganizationMembership(
			pv.organizationId,
			nominatedById,
		);
		if (membership) {
			return pv;
		}
	}

	throw new ORPCError("FORBIDDEN", {
		message:
			"This nomination refers to a prompt its author can no longer use",
	});
}
