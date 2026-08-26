/**
 * QA tab analysis generation (the QA tab work).
 *
 * The QA tab shows two kinds of content: real `TestCase` rows drafted by the
 * existing durable pipeline (never produced here), and this module's *analysis*
 * — per-criterion under-specification warnings, integration-test implications,
 * and E2E scenario outlines. The analysis is a derived view of the Clean Spec
 * (`description` + `acceptanceCriteria`), regenerated on demand from an explicit
 * button — never automatically on tab open.
 *
 * Depth comes from the project's `qaStrategyLevel` (the same knob that
 * parameterizes QA Strategy documents): LIGHT limits the output to warnings —
 * the ticket's "only functional/acceptance test cases, without integration or
 * E2E sections" — while STANDARD/STRICT add the two deeper sections.
 *
 * This module is the model half (produce the analysis). Storing it
 * (`setQaAnalysis`) and stamping depth/specHash/generatedAt live in the
 * procedure. Writing only `qaAnalysis` keeps this PM-sync isolated (§7.7).
 */

import { getLockedAttachmentRulesClause } from "@repo/agent-prompts";
import {
	boundAcceptanceCriteria,
	generateObject,
	getAIModelWithMetadata,
} from "@repo/ai";
import { getProjectFunctionTagClause } from "@repo/ai/lib/function-tag-context";
// Imported from the SUBPATH so callers clamp output-token budgets identically to
// the merged reference site. See the helper for the Databricks 8,192 /
// Anthropic-direct 4,096 truncation this guards against.
import { computeScaledOutputTokenBudget } from "@repo/ai/lib/output-token-budget";
import {
	type FeatureMaturationState,
	getBoundPromptForAgent,
	type MaturationTenantFilter,
	type QaAnalysisWarning,
	type QaStrategyLevel,
} from "@repo/database";
import { combineCleanSpec } from "@repo/utils/clean-spec-content";
import { zodSchema } from "ai";
import { z } from "zod";

/** Agent key + document type for the (org-editable) QA analysis prompt. */
const QA_ANALYSIS_PROMPT_AGENT = "qa_analysis_generator";
const QA_ANALYSIS_PROMPT_DOCUMENT_TYPE = "QA_ANALYSIS";

/**
 * Lenient, strings-only generation schema. The model's job is prose, not
 * structure: every field is a plain string (or a list of two-string objects)
 * and anything stricter — enums, unions, length bounds — just multiplies
 * schema-rejection retries. Normalization happens in code below.
 */
const QaAnalysisGenerationSchema = z.object({
	warnings: z
		.array(
			z.object({
				criterionRef: z
					.string()
					.describe(
						'Which acceptance criterion the warning concerns, as a short label like "AC 3". Empty string if it concerns the spec as a whole.',
					),
				warning: z
					.string()
					.describe(
						"Why this criterion is too under-defined or ambiguous to test reliably, and what needs clarifying.",
					),
			}),
		)
		.describe(
			"Under-specification warnings. Empty array when every criterion is concrete enough to test.",
		),
	integrationNotes: z
		.string()
		.describe(
			"Markdown: integration-test implications and cross-feature risks. Empty string when not requested or none apply.",
		),
	e2eScenarios: z
		.string()
		.describe(
			"Markdown: end-to-end test scenario outlines. Empty string when not requested.",
		),
});

/**
 * Default instruction text, used when no `qa_analysis_generator` prompt is
 * bound for the tenant. An org can override via the Prompt Library to bias the
 * analysis toward the risks it cares about.
 */
const DEFAULT_QA_ANALYSIS_INSTRUCTIONS = `You are a senior QA engineer reviewing a feature specification before test planning. Analyse the specification and its acceptance criteria for testability.

Produce:
- Under-specification warnings: for each acceptance criterion that is too vague, ambiguous, or incomplete to test reliably, one warning naming the criterion (as "AC N", counting the criteria in the order they appear) and what must be clarified before tests can be defined. Only flag genuine ambiguity — do not invent problems, and return no warnings when the criteria are concrete.
- Integration test implications: where this feature touches other features, shared data, external systems, or permissions, describe what integration tests must cover and which cross-feature regressions are the biggest risks. Use concise markdown bullets.
- End-to-end scenario outlines: the few user journeys that exercise this feature end to end, each as a short titled outline (setup → steps → expected outcome). Cover the happy path plus the riskiest failure paths.

Rules:
- Ground everything in the specification. Never invent behaviour it does not describe.
- Be concise and concrete — this is a working QA aid, not a formal document.
- Write in plain, direct prose. No preamble.`;

/**
 * Depth clause appended to the instructions. LIGHT hard-limits the output to
 * warnings (the two deeper sections MUST come back empty — the tab hides them,
 * but an empty store is what keeps a later depth change honest). STRICT widens
 * the E2E/integration lens the same way `qaStrategyLevel` widens QA Strategy
 * documents.
 */
function depthClause(depth: QaStrategyLevel): string {
	switch (depth) {
		case "LIGHT":
			return 'QA depth for this project is LIGHT (prototype). Produce ONLY the under-specification warnings. Return an empty string for "integrationNotes" and an empty string for "e2eScenarios" — do not produce those sections.';
		case "STANDARD":
			return "QA depth for this project is STANDARD. Produce all three outputs: warnings, integration test implications, and E2E scenario outlines.";
		case "STRICT":
			return "QA depth for this project is STRICT (production). Produce all three outputs, and be exhaustive in the integration and E2E sections: include negative paths, permission/tenant boundaries, concurrency, and accessibility-relevant flows where the specification implies them.";
		default: {
			const _exhaustive: never = depth;
			return _exhaustive;
		}
	}
}

/**
 * Resolve the QA analysis instruction text for a tenant: the bound
 * `qa_analysis_generator` prompt when present and non-empty, else the built-in
 * default.
 */
async function resolveQaAnalysisInstructions({
	tenantFilter,
}: {
	tenantFilter: MaturationTenantFilter;
}): Promise<string> {
	const bound = await getBoundPromptForAgent({
		agentName: QA_ANALYSIS_PROMPT_AGENT,
		documentType: QA_ANALYSIS_PROMPT_DOCUMENT_TYPE,
		storyKind: "FEATURE",
		userId: tenantFilter.userId,
		organizationId: tenantFilter.organizationId ?? undefined,
	});
	const content = bound?.version?.content?.trim();
	return content && content.length > 0
		? content
		: DEFAULT_QA_ANALYSIS_INSTRUCTIONS;
}

export interface GeneratedQaAnalysis {
	warnings: QaAnalysisWarning[];
	integrationNotes: string;
	e2eScenarios: string;
}

export interface GenerateQaAnalysisParams {
	feature: FeatureMaturationState;
	tenantFilter: MaturationTenantFilter;
	depth: QaStrategyLevel;
	/**
	 * Titles of the project's OTHER features, so integration/cross-feature
	 * risks can be grounded in what actually exists (the QA tab work AC-3) — with
	 * only its own spec the model cannot know any other feature exists.
	 */
	projectFeatures?: { identifier: string | null; title: string }[];
	/**
	 * The feature's already-drafted test cases, supplied ONLY when the project
	 * has "Apply TDD approach" switched on (the TDD flow's feature-review step: "Feature
	 * Review — based on Requirements AND Test Cases").
	 *
	 * Under TDD the cases are written before the implementation, so they are
	 * part of the contract under review: the analysis should flag a criterion
	 * the cases contradict, or a case testing something the spec never promises.
	 * Without TDD the cases are drafted AFTER this review, so reviewing against
	 * them would just be grading the model's own later output — the caller
	 * passes nothing and the block disappears.
	 */
	tddTestCases?: { identifier: string; title: string }[];
}

/**
 * The TDD review block: the cases already drafted from this spec.
 *
 * Kept in code rather than in the editable prompt for the same reason as the
 * sibling-features and locked-attachment clauses — it must survive an org
 * prompt override. Absent unless the project runs TDD, which is what finally
 * makes the "Apply TDD approach" switch change an outcome rather than a
 * sentence of copy.
 */
export function tddTestCasesClause(
	cases: { identifier: string; title: string }[] | undefined,
): string {
	if (!cases || cases.length === 0) {
		return "";
	}
	// Bounded: a mature feature can carry dozens of cases and this rides inside
	// an already-large spec prompt.
	const listed = cases
		.slice(0, 60)
		.map((c) => `- ${c.identifier}: ${c.title}`)
		.join("\n");
	return [
		"",
		"",
		"TEST CASES ALREADY WRITTEN FOR THIS FEATURE (this project is test-driven: these were drafted BEFORE implementation and form part of the contract):",
		listed,
		"",
		"Review the specification against these cases as well as on its own terms. Call out any acceptance criterion the cases contradict, any case testing behaviour the specification never promises, and any criterion no case covers.",
		"",
		// The test-case generation settings step 3 — "Requirements Reviewed / Updated, based on generated
		// test-case flows". Fabric runs steps 3 and 5 as ONE analysis pass rather
		// than two (see docs/qa/qa-settings.md), so without this the two outputs
		// blend: a reader cannot tell a warning the SPEC earned on its own from one
		// the drafted flows exposed. Step 3's whole value is the second kind — it is
		// the feedback edge that makes drafting cases first worth doing.
		'Where a warning exists BECAUSE writing these cases exposed it, begin that warning with "Drafting revealed:" and name the case that exposed it. Attribute it that way only when the case is the evidence — a criterion that was already vague on its own terms is not a drafting discovery.',
	].join("\n");
}

/**
 * Compose the sibling-features context block. Kept in code (not the editable
 * prompt) so it survives org prompt overrides, mirroring the locked-attachment
 * clause. Empty when the project has no other features.
 */
function projectFeaturesClause(
	projectFeatures: { identifier: string | null; title: string }[] | undefined,
): string {
	if (!projectFeatures || projectFeatures.length === 0) {
		return "";
	}
	const lines = projectFeatures
		.map((f) => `- ${f.identifier ? `${f.identifier}: ` : ""}${f.title}`)
		.join("\n");
	return `\n\nOTHER FEATURES IN THIS PROJECT (context for integration analysis only):\n${lines}\nYou may reference these when describing integration touchpoints and cross-feature regression risks. Do not invent behaviour for them beyond what their titles and this specification imply.`;
}

/**
 * Generate the QA analysis from a feature's Clean Spec. Returns `null` when the
 * spec is empty (nothing to analyse). Model resolution is tenant-coupled (usage
 * limits enforced at resolution).
 */
export async function generateQaAnalysis({
	feature,
	tenantFilter,
	depth,
	projectFeatures,
	tddTestCases,
}: GenerateQaAnalysisParams): Promise<GeneratedQaAnalysis | null> {
	// The AC blob is bounded at the first sibling section for the PROMPT so the
	// model numbers real criteria only (leaked "## Release Planning" content
	// otherwise draws warnings and skews "AC N"). The staleness HASH in the
	// procedure deliberately stays on the RAW columns — any spec edit,
	// including the leaked tail, must still flag the analysis stale.
	const spec = combineCleanSpec(
		feature.description,
		feature.acceptanceCriteria
			? boundAcceptanceCriteria(feature.acceptanceCriteria)
			: feature.acceptanceCriteria,
	);
	if (!spec.trim()) {
		return null;
	}

	const instructions = await resolveQaAnalysisInstructions({ tenantFilter });

	const { model, metadata } = await getAIModelWithMetadata(
		{ taskType: "COMPLEX" },
		{
			userId: tenantFilter.userId,
			organizationId: tenantFilter.organizationId ?? undefined,
		},
	);

	// Same composition rules as the Summary digest: the locked-attachment clause
	// holds regardless of prompt overrides, and the project's function-tag role
	// clause is appended when the flag mints one.
	const roleClause = feature.projectId
		? await getProjectFunctionTagClause({
				projectId: feature.projectId,
				requesterUserId: tenantFilter.userId,
				surface: "generate-qa-analysis",
			})
		: "";

	const prompt = `${instructions}

${depthClause(depth)}

${getLockedAttachmentRulesClause()}${projectFeaturesClause(projectFeatures)}

FEATURE SPECIFICATION:
${spec}${tddTestCasesClause(tddTestCases)}${roleClause ? `\n\n${roleClause}` : ""}`;

	// Scaled mode: the QA analysis restates and reasons over the spec, so output
	// tracks the spec size. Without an explicit budget Databricks/Anthropic-direct
	// truncate at their injected defaults; `undefined` for providers that don't
	// need the workaround (they keep their SDK defaults).
	const maxOutputTokens = computeScaledOutputTokenBudget(metadata, {
		inputChars: spec.length,
		promptChars: prompt.length,
	});

	const { object } = await generateObject({
		model,
		schema: zodSchema(QaAnalysisGenerationSchema),
		prompt,
		...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
	});

	// Normalize in code, not in the schema: drop blank warnings, trim refs, and
	// force the deeper sections empty at LIGHT even if the model ignored the
	// depth clause.
	const warnings: QaAnalysisWarning[] = [];
	for (const entry of object.warnings ?? []) {
		const warning = entry?.warning?.trim();
		if (!warning) {
			continue;
		}
		warnings.push({
			criterionRef: entry.criterionRef?.trim() ?? "",
			warning,
		});
	}
	const light = depth === "LIGHT";
	return {
		warnings,
		integrationNotes: light ? "" : (object.integrationNotes?.trim() ?? ""),
		e2eScenarios: light ? "" : (object.e2eScenarios?.trim() ?? ""),
	};
}
