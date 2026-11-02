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
import {
	PROPOSAL_ONLY_VISUAL_KINDS,
	type ProposalOnlyVisualKind,
} from "@repo/utils/glossy/visual-spec";
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
 * - a ref this call did not issue, or a kind outside the five (seven for a
 *   Proposal), is discarded;
 * - a kind the section already shows (a slot or existing diagram) is discarded;
 * - at most one opportunity per section and `limit` in total (at most eight);
 * - reasons are plain text capped at 160 characters (KTD13).
 *
 * Style direction is deliberately not an input (KTD8).
 *
 * A Proposal's visuals step (`proposalArtifact`, Fizzy #2946) may also be
 * offered `layers` and `team`, which only the Proposal draws; Glossy's kinds,
 * prompt and output schema are unchanged.
 */

const DETECTION_LOG = "[GlossyDetect]";

/** The kinds a Proposal's visuals step may be offered: Glossy's and its own. */
export type ProposalDetectableKind =
	| GlossyDetectableKind
	| ProposalOnlyVisualKind;

const PROPOSAL_DETECTABLE_KINDS: readonly ProposalDetectableKind[] = [
	...GLOSSY_DETECTABLE_KINDS,
	...PROPOSAL_ONLY_VISUAL_KINDS,
];

/**
 * The model names sections by ref. Every field is a plain string so that a
 * stray value is filtered in code instead of failing schema validation.
 */
function detectionOutputSchema(kinds: readonly string[]) {
	return z.object({
		opportunities: z
			.array(
				z.object({
					sectionRef: z
						.string()
						.describe(
							"The section's ref, exactly as given in the input.",
						),
					kind: z.string().describe(`One of: ${kinds.join(", ")}.`),
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
}

export const GlossyDetectionOutputSchema = detectionOutputSchema(
	GLOSSY_DETECTABLE_KINDS,
);

/** Glossy's schema, naming the Proposal's own kinds among the choices too. */
const ProposalDetectionOutputSchema = detectionOutputSchema(
	PROPOSAL_DETECTABLE_KINDS,
);

export interface GlossyDetectionSection {
	sectionKey: string;
	heading: string | null;
	/** The cleaned section body (`GlossySection.markdown`). */
	markdown: string;
	/** Kinds the section already shows through a slot or existing diagram. */
	reservedKinds?: readonly GlossyDetectableKind[];
	/** A Proposal's appendix section (Fizzy #2946); Glossy never sets it. */
	appendix?: boolean;
}

export interface DetectGlossyOpportunitiesInput extends GlossyModelContext {
	documentType: string;
	/** In document order. */
	sections: readonly GlossyDetectionSection[];
	/** Remaining opportunity budget; clamped to 0–8, default 8. */
	limit?: number;
	/**
	 * The Proposal artifact's visuals step: adds audience guidance to the
	 * instructions and offers the Proposal's own kinds (Fizzy #2946). Unset
	 * for Glossy, whose prompt is unchanged.
	 */
	proposalArtifact?: boolean;
}

/** A Proposal's visuals step, which may get back `layers` and `team` too. */
export interface DetectProposalOpportunitiesInput
	extends Omit<DetectGlossyOpportunitiesInput, "proposalArtifact"> {
	proposalArtifact: true;
}

export interface GlossyOpportunity<
	Kind extends ProposalDetectableKind = GlossyDetectableKind,
> {
	sectionKey: string;
	kind: Kind;
	/** Plain text, at most 160 characters. */
	reason: string;
}

export type GlossyDetectionResult<
	Kind extends ProposalDetectableKind = GlossyDetectableKind,
> =
	| {
			status: "detected";
			/** In document order. */
			opportunities: GlossyOpportunity<Kind>[];
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
const PROPOSAL_DETECTABLE = new Set<string>(PROPOSAL_DETECTABLE_KINDS);

function sectionRef(index: number): string {
	return `sec-${index + 1}`;
}

export function detectGlossyOpportunities(
	input: DetectProposalOpportunitiesInput,
): Promise<GlossyDetectionResult<ProposalDetectableKind>>;
export function detectGlossyOpportunities(
	input: DetectGlossyOpportunitiesInput,
): Promise<GlossyDetectionResult>;
export async function detectGlossyOpportunities(
	input: DetectGlossyOpportunitiesInput,
): Promise<GlossyDetectionResult<ProposalDetectableKind>> {
	const proposal = input.proposalArtifact === true;
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

	const instructions = buildGlossyDetectInstructions(input.documentType, {
		proposalArtifact: input.proposalArtifact,
	});
	const prompt = buildGlossyDetectPrompt({
		limit,
		sections: input.sections.map((section, index) => ({
			ref: sectionRef(index),
			heading: section.heading,
			markdown: section.markdown,
			reservedKinds: section.reservedKinds,
			appendix: section.appendix,
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
			schema: zodSchema(
				proposal
					? ProposalDetectionOutputSchema
					: GlossyDetectionOutputSchema,
			),
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
	const detectable = proposal ? PROPOSAL_DETECTABLE : DETECTABLE;
	const taken = new Set<string>();
	const kept: Array<
		GlossyOpportunity<ProposalDetectableKind> & { order: number }
	> = [];
	for (const entry of object.opportunities) {
		if (kept.length >= limit) {
			break;
		}
		const index = refs.get(entry.sectionRef.trim());
		const kind = entry.kind.trim();
		if (index === undefined || !detectable.has(kind)) {
			continue;
		}
		const section = input.sections[index];
		const reserved: readonly string[] = section.reservedKinds ?? [];
		if (taken.has(section.sectionKey) || reserved.includes(kind)) {
			continue;
		}
		taken.add(section.sectionKey);
		kept.push({
			sectionKey: section.sectionKey,
			kind: kind as ProposalDetectableKind,
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
