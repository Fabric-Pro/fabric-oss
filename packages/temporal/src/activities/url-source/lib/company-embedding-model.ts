/**
 * The embedding model a company owner's pages are indexed with now, for the
 * crawl activities that compare it with the model a page's vectors were
 * written by.
 */
import { resolveCompanyEmbeddingModel } from "@repo/rag";
import type { CompanyContextOwner } from "../../../lib/context-owner";
import { activityLogger } from "../../lib/activity-logger";

/**
 * The identity of the organization's current embedding model, or `null` when
 * it cannot be resolved. The caller decides what `null` means for its page;
 * `onUnresolved` says so in the warning ("keeping the page's vectors").
 */
export async function currentCompanyEmbeddingModel(
	owner: CompanyContextOwner,
	userId: string | null,
	onUnresolved: string,
): Promise<string | null> {
	try {
		const model = await resolveCompanyEmbeddingModel({
			organizationId: owner.organizationId,
			userId: userId ?? "",
		});
		return model.identity;
	} catch (error) {
		activityLogger.warn(
			`Could not resolve the organization's embedding model; ${onUnresolved}`,
			{
				organizationId: owner.organizationId,
				error: error instanceof Error ? error.message : String(error),
			},
		);
		return null;
	}
}
