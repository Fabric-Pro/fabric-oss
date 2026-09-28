import {
	boundGlossyField,
	buildGlossyDetectInstructions,
	buildGlossyDetectPrompt,
	GLOSSY_DETECTABLE_KINDS,
	GLOSSY_MAX_OPPORTUNITIES,
	GLOSSY_REASON_MAX_CHARS,
	type GlossyDetectableKind,
} from "@repo/agent-prompts/glossy";
import { generateObject, NoObjectGeneratedError, zodSchema } from "@repo/ai";
// Imported from the SUBPATH (not @repo/ai root) so it stays unmocked in tests
// that mock the root module, as in update-with-context-core.ts.
import { computeScaledOutputTokenBudget } from "@repo/ai/lib/output-token-budget";
import { z } from "zod";
import {
	type GlossyAiProviderNotConfigured,
	type GlossyModelContext,
	resolveGlossyModel,
} from "./model";

/**
 * Visual-opportunity detection for a Glossy build (Fizzy #2589, R17, KTD9).
 *
 * One document-level `generateObject` over the sections to consider: every
 * section on a first build, only the changed ones on a rebuild, with the
 * remaining budget as `limit`. The model's answer is untrusted output, so it
 * is filtered here rather than by the schema — one bad item must not fail
 * the whole call:
 * - a ref this call did not issue, or a kind outside the five, is discarded;
 * - a kind the section already shows (a slot or existing diagram) is discarded;
 * - at most one opportunity per section and `limit` in total (at most eight);
 * - reasons are plain text capped at 160 characters (KTD13).
 *
 * Style direction is deliberately not an input (KTD8).
 */

const DETECTION_LOG = "[GlossyDetect]";

/**
 * The model names sections by ref. Every field is a plain string so that a
 * stray value is filtered in code instead of failing schema validation.
 */
export const GlossyDetectionOutputSchema = z.object({
	opportunities: z
		.array(
			z.object({
				sectionRef: z
					.string()
					.describe(
						"The section's ref, exactly as given in the input.",
					),
				kind: z
					.string()
					.describe(`One of: ${GLOSSY_DETECTABLE_KINDS.join(", ")}.`),
				reason: z
					.string()
					.describe(
						`One short plain-text sentence, at most ${GLOSSY_REASON_MAX_CHARS} characters, saying what in the section suits the kind.`,
					),
			}),
		)
		.describe(
			"At most one entry per section. An empty list when no section suits a visual.",
		),
});

export interface GlossyDetectionSection {
	sectionKey: string;
	heading: string | null;
	/** The cleaned section body (`GlossySection.markdown`). */
	markdown: string;
	/** Kinds the section already shows through a slot or existing diagram. */
	reservedKinds?: readonly GlossyDetectableKind[];
}

export interface DetectGlossyOpportunitiesInput extends GlossyModelContext {
	documentType: string;
	/** In document order. */
	sections: readonly GlossyDetectionSection[];
	/** Remaining opportunity budget; clamped to 0–8, default 8. */
	limit?: number;
}

export interface GlossyOpportunity {
	sectionKey: string;
	kind: GlossyDetectableKind;
	/** Plain text, at most 160 characters. */
	reason: string;
}

export type GlossyDetectionResult =
	| {
			status: "detected";
			/** In document order. */
			opportunities: GlossyOpportunity[];
			/** Model entries dropped by the filters above. */
			discarded: number;
	  }
	| {
			/** The one call failed in a way a retry at the same budget would not fix; build without detected visuals. */
			status: "degraded";
			reason: "truncated" | "invalidOutput";
			opportunities: [];
	  }
	| GlossyAiProviderNotConfigured;

const DETECTABLE = new Set<string>(GLOSSY_DETECTABLE_KINDS);

function sectionRef(index: number): string {
	return `sec-${index + 1}`;
}

export async function detectGlossyOpportunities(
	input: DetectGlossyOpportunitiesInput,
): Promise<GlossyDetectionResult> {
	const limit = Math.max(
		0,
		Math.min(
			GLOSSY_MAX_OPPORTUNITIES,
			Math.floor(input.limit ?? GLOSSY_MAX_OPPORTUNITIES),
		),
	);
	if (limit === 0 || input.sections.length === 0) {
		return { status: "detected", opportunities: [], discarded: 0 };
	}

	const resolved = await resolveGlossyModel(input);
	if (resolved.status !== "resolved") {
		return resolved;
	}
	const { model, metadata, trackUsage } = resolved;

	const instructions = buildGlossyDetectInstructions(input.documentType);
	const prompt = buildGlossyDetectPrompt({
		limit,
		sections: input.sections.map((section, index) => ({
			ref: sectionRef(index),
			heading: section.heading,
			markdown: section.markdown,
			reservedKinds: section.reservedKinds,
		})),
	});
	// The answer is a short list regardless of document size, so scaled mode
	// with no input term requests the floor: enough to clear the injected
	// 4,096 / 8,192 defaults, `undefined` for providers that need no budget.
	const maxOutputTokens = computeScaledOutputTokenBudget(metadata, {
		inputChars: 0,
		promptChars: instructions.length + prompt.length,
	});

	let object: z.infer<typeof GlossyDetectionOutputSchema>;
	try {
		({ object } = await generateObject({
			model,
			schema: zodSchema(GlossyDetectionOutputSchema),
			instructions,
			prompt,
			...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
			...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
		}));
	} catch (error) {
		if (NoObjectGeneratedError.isInstance(error)) {
			const reason =
				error.finishReason === "length" ? "truncated" : "invalidOutput";
			console.warn(`${DETECTION_LOG} Detection degraded`, {
				reason,
				projectId: input.projectId,
				sections: input.sections.length,
				provider: metadata.provider,
			});
			return { status: "degraded", reason, opportunities: [] };
		}
		throw error;
	}
	trackUsage();

	const refs = new Map(
		input.sections.map((_section, index) => [sectionRef(index), index]),
	);
	const taken = new Set<string>();
	const kept: Array<GlossyOpportunity & { order: number }> = [];
	for (const entry of object.opportunities) {
		if (kept.length >= limit) {
			break;
		}
		const index = refs.get(entry.sectionRef.trim());
		const kind = entry.kind.trim();
		if (index === undefined || !DETECTABLE.has(kind)) {
			continue;
		}
		const section = input.sections[index];
		if (
			taken.has(section.sectionKey) ||
			section.reservedKinds?.includes(kind as GlossyDetectableKind)
		) {
			continue;
		}
		taken.add(section.sectionKey);
		kept.push({
			sectionKey: section.sectionKey,
			kind: kind as GlossyDetectableKind,
			reason:
				boundGlossyField(entry.reason, GLOSSY_REASON_MAX_CHARS) ?? "",
			order: index,
		});
	}

	const discarded = object.opportunities.length - kept.length;
	if (discarded > 0) {
		console.info(`${DETECTION_LOG} Discarded model entries`, {
			projectId: input.projectId,
			returned: object.opportunities.length,
			kept: kept.length,
		});
	}
	return {
		status: "detected",
		opportunities: kept
			.sort((a, b) => a.order - b.order)
			.map(({ order: _order, ...opportunity }) => opportunity),
		discarded,
	};
}
