import { getAIModelWithMetadata } from "@repo/ai";
import type { LanguageModel } from "ai";

/**
 * Resolve the AI model for a weave reader agent using the standard
 * centralized model resolution system. Respects user/org model preferences
 * and provider configuration from the database.
 *
 * Task type CHAT is used for reader agents (Thread, Spindle, Weft, Warp)
 * since they are conversational research/review agents.
 *
 * The Metadata variant is required so the attribution label reaches the
 * usage interceptor — the plain getAIModel would still meter tokens but
 * without the weave-reader job label (Fizzy #1894).
 */
export async function resolveReaderModel(tenant: {
	userId: string;
	organizationId?: string | null;
}): Promise<LanguageModel> {
	const { model } = await getAIModelWithMetadata(
		{ taskType: "CHAT" },
		{
			userId: tenant.userId,
			organizationId: tenant.organizationId ?? undefined,
			jobType: "weave-reader",
		},
	);
	return model;
}
