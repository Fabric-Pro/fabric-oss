import {
	type AIModelResult,
	AIProviderNotConfiguredError,
	type AiFeatureKey,
	getAIModelWithMetadata,
} from "@repo/ai";

/**
 * Model resolution for every Glossy call (Fizzy #2589, KTD21).
 *
 * BYOK is the resolver's answer for the requesting editor: the editor's
 * `userId`, the project's organization, and the `glossy-edition` feature key.
 * A personal key counts, per the BYOK concept. A missing provider is not an
 * exception here but a typed result, so the build procedure can refuse with
 * a prompt to configure one (AE6) and an activity can fail without retrying.
 * Every other error — a provider outage, a usage-limit breach — propagates
 * unchanged, so callers keep its identity.
 *
 * Lives in @repo/temporal so the in-request callers (Align-first detection,
 * single-visual regenerate, KTD10) and the build activities run the same
 * code; the API reaches it through the package's root barrel.
 */

export const GLOSSY_FEATURE_KEY = "glossy-edition" satisfies AiFeatureKey;

/**
 * Every Glossy call runs as the editor who asked for it, inside the
 * project's organization. `organizationId` is required: Glossy rows always
 * carry one, and an `undefined` here would silently select the fail-closed
 * personal arm of provider resolution.
 */
export interface GlossyModelContext {
	userId: string;
	organizationId: string;
	projectId: string;
	/** Cancels the in-flight model call, e.g. when an activity is cancelled. */
	abortSignal?: AbortSignal;
}

/** KTD21's typed outcome; the message is fixed and safe to show or persist. */
export interface GlossyAiProviderNotConfigured {
	status: "aiProviderNotConfigured";
	message: string;
}

export const GLOSSY_AI_PROVIDER_NOT_CONFIGURED_MESSAGE =
	"No AI provider is configured for this organization or for your account. Configure one in Settings → AI Providers.";

export type GlossyResolvedModel =
	| ({ status: "resolved" } & AIModelResult)
	| GlossyAiProviderNotConfigured;

export function glossyAiProviderNotConfigured(): GlossyAiProviderNotConfigured {
	return {
		status: "aiProviderNotConfigured",
		message: GLOSSY_AI_PROVIDER_NOT_CONFIGURED_MESSAGE,
	};
}

export async function resolveGlossyModel(
	context: GlossyModelContext,
): Promise<GlossyResolvedModel> {
	try {
		const resolved = await getAIModelWithMetadata(
			{ taskType: "COMPLEX" },
			{
				userId: context.userId,
				organizationId: context.organizationId,
				projectId: context.projectId,
				featureKey: GLOSSY_FEATURE_KEY,
			},
		);
		return { status: "resolved", ...resolved };
	} catch (error) {
		if (error instanceof AIProviderNotConfiguredError) {
			return glossyAiProviderNotConfigured();
		}
		throw error;
	}
}
