import type { AIProvider } from "../generated/client";

export const IMAGE_RUNTIME_PROVIDERS = [
	"VERCEL_GATEWAY",
	"OPENAI_DIRECT",
] as const satisfies readonly AIProvider[];

/**
 * The latest administrative decision wins. The id makes equal timestamps
 * deterministic for both runtime resolution and settings display order.
 */
export const LATEST_IMAGE_MODEL_PREFERENCE_ORDER_BY = [
	{ updatedAt: "desc" },
	{ id: "desc" },
] as const;
