/**
 * Business onboarding tour — an AI-narrated, ordered walkthrough of the
 * repo's business capabilities for a NON-TECHNICAL newcomer. Generated after
 * the business graph is derived; rendered as a step-through guide in Business
 * mode (highlighting each capability node with a plain-language narrative).
 *
 * Degrades gracefully (returns null) when no AI provider is configured.
 */
import {
	AIProviderNotConfiguredError,
	generateObject,
	getAIModelWithMetadata,
} from "@repo/ai";
import { logger } from "@repo/logs";
import { z } from "zod";
import {
	EMPTY_TOKEN_TOTALS,
	extractReasoningText,
	type TokenTotals,
	tokenTotalsFromUsage,
} from "./cost";
import type {
	AtlasContext,
	BusinessTour,
	TourCapabilityInput,
	TourStep,
} from "./types";
import { recordAtlasUsage } from "./usage";

export type { TourCapabilityInput };

/** The generated tour (or null) plus accumulated AI telemetry (T3). */
export interface BusinessTourResult {
	tour: BusinessTour | null;
	usage: TokenTotals;
	model: string | null;
	reasoning: string | null;
}

// Strict-mode safe: every field required (Azure/OpenAI structured output).
const schema = z.object({
	intro: z.string(),
	steps: z.array(
		z.object({
			capabilityIndex: z.number(),
			title: z.string(),
			narrative: z.string(),
		}),
	),
});

// NOTE: candidate for the future runtime-editable system-prompt bindings.
function buildTourPrompt(
	capabilities: TourCapabilityInput[],
	repoName: string | null,
): string {
	const lines = [
		`You are onboarding a NON-TECHNICAL newcomer to the product${
			repoName ? ` "${repoName}"` : ""
		}.`,
		"Using ONLY the business capabilities below, write a guided tour. Stay grounded in their names and descriptions — do not invent capabilities, features, or claims they do not support.",
		"- intro: a substantive plain-language overview (1-2 short paragraphs, ~4-7 sentences) of what the product does and the value it delivers — the problem it solves, who it is for, the main things people can do with it, and how the major capabilities fit together into a coherent whole. Be concrete and specific to THIS product (draw on the capability descriptions below), not generic; no marketing fluff or invented numbers.",
		"- steps: an ordered walkthrough (logical order, main/entry capability first, then the supporting ones it leads into), ONE step per capability, each with a short plain-language title and a 2-3 sentence narrative of what it does, why it matters to the user, and how it connects to the other capabilities in the tour.",
		"Reference each capability by its index. Avoid technical jargon; if a term is unavoidable, explain it in one short clause.",
		"",
		"Capabilities:",
	];
	capabilities.forEach((c, i) => {
		lines.push(`${i}. ${c.label} — ${c.description}`);
	});
	return lines.join("\n");
}

const EMPTY_TOUR_RESULT: BusinessTourResult = {
	tour: null,
	usage: EMPTY_TOKEN_TOTALS,
	model: null,
	reasoning: null,
};

export async function generateBusinessTour(
	capabilities: TourCapabilityInput[],
	repoName: string | null,
	ctx: AtlasContext,
	projectId?: string,
): Promise<BusinessTourResult> {
	if (capabilities.length === 0) {
		return EMPTY_TOUR_RESULT;
	}

	let resolution: Awaited<ReturnType<typeof getAIModelWithMetadata>>;
	try {
		resolution = await getAIModelWithMetadata(
			{ taskType: "SIMPLE" },
			{
				userId: ctx.userId,
				organizationId: ctx.organizationId ?? undefined,
			},
		);
	} catch (error) {
		if (!(error instanceof AIProviderNotConfiguredError)) {
			logger.warn("[atlas] tour model resolution error", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return EMPTY_TOUR_RESULT;
	}

	const startedAt = Date.now();
	try {
		const result = await generateObject({
			model: resolution.model,
			schema,
			prompt: buildTourPrompt(capabilities, repoName),
		});
		const { object, usage } = result;
		recordAtlasUsage({
			ctx,
			metadata: resolution.metadata,
			taskType: "SIMPLE",
			usage,
			startedAt,
			projectId,
		});
		resolution.trackUsage();

		const telemetry = {
			usage: tokenTotalsFromUsage(usage),
			model: resolution.metadata?.canonicalName ?? null,
			reasoning: extractReasoningText(result),
		};

		const steps: TourStep[] = [];
		const seen = new Set<string>();
		for (const s of object.steps) {
			const cap = capabilities[s.capabilityIndex];
			if (!cap || seen.has(cap.key)) {
				continue;
			}
			seen.add(cap.key);
			steps.push({
				capabilityKey: cap.key,
				title: s.title,
				narrative: s.narrative,
			});
		}
		// Ensure every capability is covered (append any the model skipped).
		for (const cap of capabilities) {
			if (!seen.has(cap.key)) {
				steps.push({
					capabilityKey: cap.key,
					title: cap.label,
					narrative: cap.description,
				});
			}
		}
		if (steps.length === 0) {
			return { tour: null, ...telemetry };
		}
		return { tour: { intro: object.intro, steps }, ...telemetry };
	} catch (error) {
		logger.warn("[atlas] tour generation failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		return EMPTY_TOUR_RESULT;
	}
}
