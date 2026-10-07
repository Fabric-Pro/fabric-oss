/**
 * Who may use company context in an Advisor chat, and for which organization
 * (Fizzy #2719).
 *
 * Company context is the organization's material about itself, for its
 * members only. A chat asks this module on every use — before telling the
 * model the organization has company context, and before every search — so a
 * membership or gate change takes effect on the next turn.
 *
 * The order follows the Proposal and Business Case notice state: project,
 * then tenant, then membership, then gate. It uses `@repo/database` and
 * `@repo/rag` helpers only; `@repo/api` depends on this package.
 */

import {
	companyContextReadyWhere,
	db,
	isFeatureEnabled,
	isOrganizationMember,
	resolveProjectTenant,
} from "@repo/database";
import { logger } from "@repo/logs";
import { resolveCompanyEmbeddingModel } from "@repo/rag";

export interface CompanyContextChatAccess {
	/** The organization whose company context the chat may use. */
	organizationId: string;
	/** Its display name, as stored: data, never an instruction. */
	organizationName: string;
	/**
	 * Its sources ready for retrieval right now. Zero is a valid answer: the
	 * person may use company context, but there is nothing to search yet.
	 */
	readySourceCount: number;
}

type RefusalReason =
	| "no-user"
	| "no-organization"
	| "not-a-member"
	| "gate-off"
	| "unsupported-embedding-model"
	| "organization-not-found";

/**
 * Whether `userId` may use company context in this chat, and for which
 * organization; `null` when not.
 *
 * - With a `projectId`, the organization is the project row's, whatever the
 *   request names: company context used in a project is always that
 *   project's organization's. A project with no organization, or no such
 *   project, is `null`; the request's organization is never the fallback.
 * - Without one, it is `requestOrganizationId`; none is `null`.
 * - The person must be a member of that organization
 *   (`isOrganizationMember`). A project guest is not, and the
 *   guest-inclusive tie is deliberately not used.
 * - The `COMPANY_CONTEXT` gate must be on for that organization.
 * - "Ready" is `companyContextReadyWhere` under the organization's current
 *   company embedding model, the rule retrieval searches by. A model that
 *   cannot be resolved, or whose vectors no collection can hold, is `null`.
 *
 * A `readySourceCount` of 0 is returned as a result, not `null`. Callers
 * treat it as nothing: no hint, and a search that finds nothing.
 *
 * An id that is not a non-empty string is no id: a value from a hand-parsed
 * request body could otherwise reach a query as a filter object.
 *
 * Never throws. Any failure is logged — ids and the reason only, never a
 * query or company text — and yields `null`.
 */
export async function resolveCompanyContextChatAccess(input: {
	userId: string;
	/** The organization the request names; ignored when a project is given. */
	requestOrganizationId?: string | null;
	projectId?: string | null;
}): Promise<CompanyContextChatAccess | null> {
	const { userId, requestOrganizationId, projectId } = input;
	let organizationId: string | null | undefined;

	const refuse = (
		reason: RefusalReason,
		level: "debug" | "info" = "info",
	): null => {
		logger[level](
			"[CompanyContext] Company context not available to this chat",
			{ userId, organizationId, projectId, reason },
		);
		return null;
	};

	if (typeof userId !== "string" || !userId) {
		return refuse("no-user");
	}

	try {
		organizationId = projectId
			? (await resolveProjectTenant(projectId))?.organizationId
			: requestOrganizationId;
		if (typeof organizationId !== "string" || !organizationId) {
			return refuse("no-organization", "debug");
		}

		if (!(await isOrganizationMember(userId, organizationId))) {
			return refuse("not-a-member");
		}
		if (!(await isFeatureEnabled("COMPANY_CONTEXT", organizationId))) {
			return refuse("gate-off", "debug");
		}

		const model = await resolveCompanyEmbeddingModel({
			organizationId,
			userId,
		});
		if (!model.supported) {
			return refuse("unsupported-embedding-model");
		}

		const [organization, readySourceCount] = await Promise.all([
			db.organization.findUnique({
				where: { id: organizationId },
				select: { name: true },
			}),
			db.companyContextSource.count({
				where: {
					organizationId,
					...companyContextReadyWhere(model.identity),
				},
			}),
		]);
		if (!organization) {
			return refuse("organization-not-found");
		}

		return {
			organizationId,
			organizationName: organization.name,
			readySourceCount,
		};
	} catch (error) {
		logger.warn(
			"[CompanyContext] Could not resolve company context access; treating it as unavailable",
			{
				userId,
				organizationId,
				projectId,
				error: error instanceof Error ? error.message : String(error),
			},
		);
		return null;
	}
}
