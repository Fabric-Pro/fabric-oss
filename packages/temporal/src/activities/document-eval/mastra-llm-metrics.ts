/**
 * LLM-as-judge evaluation metrics built with Mastra scorers.
 *
 * EVAL_VERSION 3 Improvements:
 * - Document-type specific rubrics for quality scoring
 * - Two-step reasoning chain (identify issues → score)
 * - Stricter evaluation prompts
 * - Metric-specific calibration
 */

import { createScorer } from "@mastra/core/evals";
import type { MastraModelConfig } from "@mastra/core/llm";
import { heartbeat } from "@temporalio/activity";
import { z } from "zod";
import { estimateEvalCost, isOverBudget, recordEvalCost } from "./cost-tracker";
import { calibrateScore } from "./mastra-config";

/**
 * Safe heartbeat wrapper that handles non-activity contexts gracefully
 */
function safeHeartbeat(details?: unknown): void {
	try {
		heartbeat(details);
	} catch (_error) {
		// Not in an activity context (e.g., during testing)
		// Silently ignore - this is expected behavior for non-activity contexts
	}
}

const evalInputSchema = z.object({
	documentType: z.string(),
	expectedSections: z.array(z.string()).optional(),
	userPrompt: z.string().optional(),
});

const evalOutputSchema = z.string();

/**
 * Flexible string array schema that tolerates LLM output quirks.
 * gpt-4o-mini sometimes returns a number (count) or malformed string
 * instead of an array for optional fields like issues, strengths, weaknesses.
 * This coerces non-array values to an empty array to prevent validation failures.
 */
const flexibleStringArray = z
	.union([
		z.array(z.string()),
		z.string().transform((s) => (s.length > 2 ? [s] : [])),
		z.number().transform(() => []),
	])
	.optional();

const qualitySchema = z.object({
	score: z.number().min(0).max(100),
	reasoning: z.string(),
	strengths: flexibleStringArray,
	weaknesses: flexibleStringArray,
});

const coherenceSchema = z.object({
	score: z.number().min(0).max(100),
	reasoning: z.string(),
	issues: flexibleStringArray,
});

const alignmentSchema = z.object({
	score: z.number().min(0).max(100),
	reasoning: z.string(),
	addressedRequirements: flexibleStringArray,
	missedRequirements: flexibleStringArray,
});

const MAX_DOCUMENT_CHARS = 8000;

export interface LLMMetricResult {
	name: string;
	score: number;
	reasoning: string;
	details: Record<string, unknown>;
}

export interface LLMEvalResult {
	quality: LLMMetricResult | null;
	coherence: LLMMetricResult | null;
	alignment: LLMMetricResult | null;
	overallScore: number;
	executionTimeMs: number;
	costUsd: number;
	provider: string;
	model: string;
}

// ============================================================================
// PHASE 2.1: Document-Type Specific Rubrics
// ============================================================================

const QUALITY_RUBRICS: Record<string, string> = {
	prd: `
SCORING RUBRIC (0-100) - PRD Standard Format:

90-100 (Excellent):
- Clear Benefit Hypothesis: "If we [build X] for [who], then [outcome] because [reason]"
- Overview with Problem (quantified), Why Now, Goals (1-3), and Non-goals
- Users/Personas identifying Primary, Secondary, and Internal users
- Success Metrics table with Goal/Metric columns + measurement approach
- Scope clearly split into In Scope and Out of Scope
- Requirements prioritized: Must Have, Nice to Have, Non-Functional (Performance, Security, Reliability)
- Key Flows covering Happy path, Edge cases, AND Failure/recovery
- Dependencies and Risks with specific mitigation strategies
- Stakeholders with names and roles (Business, PM, Engineering, Design, QA, etc.)

70-89 (Good):
- Benefit Hypothesis present but may lack measurable outcome
- Overview covers Problem and Goals, Non-goals may be brief
- Users/Personas described (at least primary user)
- Success Metrics with targets, measurement may be brief
- Scope has In Scope and Out of Scope sections
- Requirements have Must Have defined, Nice to Have may be brief
- Key Flows cover happy path and some edge cases
- Dependencies listed, risks have some mitigation
- Stakeholders listed with roles

50-69 (Needs Work):
- Missing or vague Benefit Hypothesis
- Problem not quantified, Non-goals missing
- Users not clearly distinguished (primary vs secondary)
- Success metrics without specific targets or measurement plan
- Scope only lists In Scope (Out of Scope missing)
- No distinction between Must Have and Nice to Have
- Only happy path documented
- Risks without mitigation strategies

0-49 (Poor):
- No Benefit Hypothesis
- Missing Overview section
- No users/personas defined
- No success metrics
- No scope definition
- Requirements just a list without prioritization
- No key flows/use cases
- No stakeholders listed

IMPORTANT: Do NOT penalize for:
- Missing Work Breakdown section (optional)
- Missing Open Questions section (optional)
- Missing Release Notes section (optional)
- Document Header format variations (Title, Owner, Status can vary)
- Using tables vs bullet points for Success Metrics
- Combining Dependencies and Risks into one section`,

	architecture: `
SCORING RUBRIC (0-100):

90-100 (Excellent):
- Clear system overview with context (stakeholders, external systems)
- Architecture principles or design principles documented
- Component descriptions with responsibilities
- Data flow or interaction patterns described
- Technology stack with choices explained
- Security architecture documented (auth, data protection)
- Deployment or infrastructure architecture covered
- Scalability and performance considerations

70-89 (Good):
- System overview present
- Components described with key responsibilities
- Technology stack listed
- Security basics addressed
- Deployment considerations mentioned
- Data architecture or models described

50-69 (Needs Work):
- Vague component descriptions
- Technology listed without context
- Security not adequately addressed
- Missing deployment or infrastructure info

0-49 (Poor):
- No clear architecture description
- Missing critical sections
- Just a list of technologies without design rationale

IMPORTANT: Do NOT penalize for:
- Text descriptions instead of visual diagrams (ASCII art, Mermaid, or prose all valid)
- Missing formal "metadata" or "glossary" sections
- Combined sections (e.g., "Scalability & Performance" as one section)
- Missing formal threat model if security is otherwise addressed
- Missing stakeholder matrix if stakeholders are listed in context`,

	technical_spec: `
SCORING RUBRIC (0-100):

90-100 (Excellent):
- Clear executive summary or technical overview with project context
- System architecture documented with component interactions
- Complete data models (schema, relationships, entity descriptions)
- API specifications with endpoints, request/response examples
- Security considerations addressed (auth, data protection)
- Performance requirements defined
- Testing strategy with coverage targets
- Deployment strategy with environments (dev/staging/prod)
- Monitoring and observability plan

70-89 (Good):
- Technical overview present with architecture description
- Data models documented with key entities
- API endpoints listed (examples not required for all)
- Testing approach described
- Deployment considerations mentioned
- Security basics addressed

50-69 (Needs Work):
- Architecture described but lacking detail
- Data models incomplete or missing relationships
- API specs missing or vague
- No testing strategy
- Missing deployment or security considerations

0-49 (Poor):
- No clear architecture description
- Missing or incomplete data models
- No API documentation
- Critical sections missing

IMPORTANT: Do NOT penalize for:
- Missing formal "metadata" or "glossary" sections (these are optional)
- Missing "migration" section (only needed for existing systems)
- Using diagrams (ASCII, Mermaid) instead of detailed text descriptions
- Combining related sections (e.g., "Infrastructure" covering hosting + CI/CD)`,

	api_spec: `
SCORING RUBRIC (0-100):

90-100 (Excellent):
- Clear API overview with base URL and authentication method
- Complete endpoint documentation organized by resource/feature
- Request/response examples for key endpoints
- Error handling documented with error codes and response format
- Authentication flow documented (token-based, OAuth, API keys, etc.)
- Rate limiting or usage limits specified
- HTTP methods and paths clearly documented

70-89 (Good):
- API overview present with base URL
- Most endpoints documented with method and path
- Request/response examples for main endpoints
- Error codes listed
- Authentication described
- Some rate limiting or performance info

50-69 (Needs Work):
- Missing examples for key endpoints
- Incomplete request/response schemas
- Limited error documentation
- Authentication not clearly explained

0-49 (Poor):
- Incomplete endpoint list
- No request/response examples
- Missing authentication documentation
- No error handling info

IMPORTANT: Do NOT penalize for:
- Missing formal "metadata" or "deprecation" sections (these are optional)
- Missing separate "data models" section if schemas are inline with endpoints
- Using tables vs code blocks for endpoint documentation
- Versioning only in base URL (common pattern)
- Combining authentication usage with authentication section`,

	user_story: `
SCORING RUBRIC (0-100):

90-100 (Excellent):
- Clear user personas with roles, goals, and context
- Stories follow "As a [persona], I want [action], So that [benefit]" format
- Acceptance criteria are present and testable (Given/When/Then preferred but bullet points acceptable)
- Priority assigned (MoSCoW, P0/P1/P2, or High/Medium/Low)
- Story points or T-shirt sizes (XS/S/M/L/XL) estimated
- Stories are organized by feature area or epic
- Definition of Done or completion criteria defined
- Stories are specific to the project, not generic templates

70-89 (Good):
- Most stories well-formatted with clear personas
- Acceptance criteria present for most stories
- Priority or sizing assigned to stories
- Stories are project-specific
- Some organizational structure (by feature/epic)

50-69 (Needs Work):
- Some stories lack acceptance criteria
- Personas are vague or generic
- Missing priorities or estimates on some stories
- Stories feel template-like rather than project-specific

0-49 (Poor):
- Stories not properly formatted
- No or minimal acceptance criteria
- Missing priorities and estimates
- Generic or placeholder content

IMPORTANT: Do NOT penalize for:
- Using bullet points instead of Given/When/Then (both are valid)
- Having a brief DoD checklist instead of elaborate definition
- Using tables for persona or story organization
- Story format variations (numbered vs lettered, etc.)`,

	proposal: `
SCORING RUBRIC (0-100):

90-100 (Excellent):
- Executive summary with clear value proposition
- Scope clearly defined (in scope/out of scope)
- Deliverables listed
- Timeline with phases and milestones
- Budget breakdown with categories
- Conclusion or next steps

70-89 (Good):
- Executive summary present
- Scope outlined
- Timeline or schedule included
- Budget mentioned
- Clear structure

50-69 (Needs Work):
- Vague scope
- Timeline lacks detail
- Budget missing or incomplete
- Missing conclusion

0-49 (Poor):
- No executive summary
- Scope unclear
- No timeline
- No budget

IMPORTANT: Do NOT penalize for:
- Missing formal "metadata" or "governance" sections
- Missing explicit "risk assessment" section (optional for proposals)
- Missing "testing" or "QA plan" (not typical in proposals)
- Conclusion and Next Steps as separate sections
- Budget in table format vs prose`,

	general: `
SCORING RUBRIC (0-100):

90-100 (Excellent):
- Clear structure with logical flow
- Comprehensive content
- Professional formatting
- Actionable and specific

70-89 (Good):
- Good structure
- Adequate content
- Mostly clear

50-69 (Needs Work):
- Some structural issues
- Content could be more detailed
- Some unclear sections

0-49 (Poor):
- Poor structure
- Insufficient content
- Unclear or vague`,
};

function getQualityRubric(docType: string): string {
	return QUALITY_RUBRICS[docType.toLowerCase()] ?? QUALITY_RUBRICS.general;
}

// ============================================================================
// PHASE 2.1: Enhanced Quality Scorer with Rubrics
// ============================================================================

function createQualityScorer(params: {
	model: MastraModelConfig;
	provider: string;
}) {
	return createScorer({
		id: "document-quality",
		name: "Document Quality",
		description:
			"Evaluates clarity, completeness, and actionability with strict rubrics.",
		type: { input: evalInputSchema, output: evalOutputSchema },
	})
		.analyze({
			description: "Assess document quality using specific rubrics.",
			outputSchema: qualitySchema,
			judge: {
				model: params.model,
				instructions: `You are a STRICT document evaluator. 
Be critical and identify real issues. Do NOT give high scores to mediocre content.
Average documents should score 60-70, not 80-90.
Only exceptional documents with all required elements should score above 85.
Return valid JSON matching the schema.`,
			},
			createPrompt: ({ run }) => {
				const docType = run.input?.documentType ?? "general";
				const rubric = getQualityRubric(docType);
				const expectedSections = run.input?.expectedSections ?? [];

				return `You are evaluating a ${docType} document.

${rubric}

EXPECTED SECTIONS: ${expectedSections.join(", ") || "N/A"}

DOCUMENT TO EVALUATE:
---
${run.output.slice(0, MAX_DOCUMENT_CHARS)}
---

EVALUATION INSTRUCTIONS:
1. First, list what is MISSING from the document compared to the rubric
2. Then, identify specific WEAKNESSES in the content
3. Finally, assign a score based on the rubric above
4. Be STRICT - only well-crafted documents should score above 80

Return JSON with: score (0-100), reasoning, strengths[], weaknesses[]`;
			},
		})
		.generateScore(({ results }) => {
			const rawScore = results.analyzeStepResult?.score ?? 0;
			// Apply stricter calibration with metric-specific factor
			return calibrateScore(rawScore, params.provider, "quality");
		});
}

// ============================================================================
// PHASE 2.2: Enhanced Coherence Scorer with Issue-First Analysis
// ============================================================================

function createCoherenceScorer(params: {
	model: MastraModelConfig;
	provider: string;
}) {
	return createScorer({
		id: "document-coherence",
		name: "Document Coherence",
		description:
			"Evaluates flow, consistency, and structure using issue-first analysis.",
		type: { input: evalInputSchema, output: evalOutputSchema },
	})
		.analyze({
			description: "First identify issues, then score based on severity.",
			outputSchema: coherenceSchema,
			judge: {
				model: params.model,
				instructions: `You are a CRITICAL document reviewer.
First identify ALL issues, then calculate score by deducting points.
Start at 100 and subtract:
- Major flow issues: -20 each
- Inconsistent terminology: -10 each
- Abrupt transitions: -5 each
- Missing logical connections: -10 each
- Contradictory statements: -15 each`,
			},
			createPrompt: ({
				run,
			}) => `Evaluate the logical flow and coherence of this ${
				run.input?.documentType ?? "document"
			}.

COHERENCE CHECKLIST:
1. Does the document flow logically from introduction to conclusion?
2. Are section transitions smooth and connected?
3. Is terminology consistent throughout?
4. Are there contradictory statements?
5. Does each section build on previous sections?
6. Are cross-references accurate?

SCORING (start at 100, deduct for issues):
- Major flow break (sections in illogical order): -20
- Inconsistent terminology: -10 per instance
- Abrupt transition without connection: -5 per instance
- Missing logical connection between sections: -10
- Contradictory statements: -15 per instance
- Repeated content: -5 per instance

DOCUMENT:
---
${run.output.slice(0, MAX_DOCUMENT_CHARS)}
---

Return JSON with: score (0-100), reasoning, issues[]`,
		})
		.generateScore(({ results }) => {
			const rawScore = results.analyzeStepResult?.score ?? 0;
			return calibrateScore(rawScore, params.provider, "coherence");
		});
}

// ============================================================================
// PHASE 2.2: Enhanced Alignment Scorer with Specific Criteria
// ============================================================================

function createAlignmentScorer(params: {
	model: MastraModelConfig;
	provider: string;
}) {
	return createScorer({
		id: "document-alignment",
		name: "Prompt Alignment",
		description: "Evaluates alignment with the original user prompt.",
		type: { input: evalInputSchema, output: evalOutputSchema },
	})
		.analyze({
			description: "Assess alignment with the user's original request.",
			outputSchema: alignmentSchema,
			judge: {
				model: params.model,
				instructions: `You are a strict evaluator checking if the document matches the user's request.
Be critical - partial alignment should score 60-75, not 80-90.
Return valid JSON matching the schema.`,
			},
			createPrompt: ({ run }) => {
				if (!run.input?.userPrompt) {
					return 'Return {"score":100,"reasoning":"No user prompt provided."}';
				}

				return `Compare the document to the user's original request.

USER REQUEST:
---
${run.input.userPrompt.slice(0, 2000)}
---

GENERATED DOCUMENT:
---
${run.output.slice(0, MAX_DOCUMENT_CHARS)}
---

ALIGNMENT CRITERIA:
1. Does the document address the main request?
2. Are all specific requirements covered?
3. Is the scope appropriate (not too broad/narrow)?
4. Does it match the requested format/style?
5. Are examples provided if requested?

SCORING:
- 90-100: Fully addresses all requirements
- 70-89: Addresses most requirements with minor gaps
- 50-69: Partially addresses requirements, missing key elements
- 0-49: Does not adequately address the request

Return JSON with: score (0-100), reasoning, addressedRequirements[], missedRequirements[]`;
			},
		})
		.generateScore(({ results }) => {
			const rawScore = results.analyzeStepResult?.score ?? 0;
			return calibrateScore(rawScore, params.provider, "alignment");
		});
}

// ============================================================================
// Main LLM Metrics Runner
// ============================================================================

export async function runLLMMetrics(params: {
	documentContent: string;
	documentType: string;
	expectedSections: string[];
	userPrompt?: string;
	provider: string;
	model: string;
	modelConfig: MastraModelConfig;
	organizationId?: string;
	onUsageTracked?: () => void;
}): Promise<LLMEvalResult | null> {
	const startTime = Date.now();

	if (params.organizationId && (await isOverBudget(params.organizationId))) {
		return null;
	}

	// Background heartbeat loop to prevent timeout during long LLM calls
	const HEARTBEAT_INTERVAL_MS = 10000; // Send heartbeat every 10 seconds
	let metricsComplete = false;
	const heartbeatLoop = setInterval(() => {
		if (!metricsComplete) {
			safeHeartbeat({
				phase: "llm_metrics",
				message: "Running LLM evaluation scorers",
				durationMs: Date.now() - startTime,
			});
		}
	}, HEARTBEAT_INTERVAL_MS);

	try {
		// Log model config details for debugging (especially Azure)
		const modelInfo = params.modelConfig as unknown as {
			provider?: string;
			modelId?: string;
			specificationVersion?: string;
		};
		console.log("[LLM Metrics] Creating scorers with model config:", {
			provider: params.provider,
			model: params.model,
			configProvider: modelInfo?.provider,
			configModelId: modelInfo?.modelId,
			specificationVersion: modelInfo?.specificationVersion,
			documentType: params.documentType,
			contentLength: params.documentContent?.length,
			hasUserPrompt: !!params.userPrompt,
		});

		const qualityScorer = createQualityScorer({
			model: params.modelConfig,
			provider: params.provider,
		});
		const coherenceScorer = createCoherenceScorer({
			model: params.modelConfig,
			provider: params.provider,
		});
		const alignmentScorer = createAlignmentScorer({
			model: params.modelConfig,
			provider: params.provider,
		});

		const runInput = {
			documentType: params.documentType,
			expectedSections: params.expectedSections,
			userPrompt: params.userPrompt,
		};

		// Run all scorers with Promise.allSettled for consistent error handling
		const scorerPromises: Promise<unknown>[] = [
			qualityScorer.run({
				input: runInput,
				output: params.documentContent,
			}),
			coherenceScorer.run({
				input: runInput,
				output: params.documentContent,
			}),
		];

		// Only run alignment scorer if userPrompt is provided
		if (params.userPrompt) {
			scorerPromises.push(
				alignmentScorer.run({
					input: runInput,
					output: params.documentContent,
				}),
			);
		}

		const results = await Promise.allSettled(scorerPromises);
		const [qualityResult, coherenceResult, alignmentResult] = results as [
			PromiseSettledResult<unknown>,
			PromiseSettledResult<unknown>,
			PromiseSettledResult<unknown> | undefined,
		];

		return buildLLMEvalResult({
			qualityResult,
			coherenceResult,
			alignmentResult: params.userPrompt ? alignmentResult : null,
			params,
			executionTimeMs: Date.now() - startTime,
		});
	} finally {
		// Always clear the heartbeat loop
		clearInterval(heartbeatLoop);
		metricsComplete = true;
	}
}

async function buildLLMEvalResult(args: {
	qualityResult: PromiseSettledResult<unknown>;
	coherenceResult: PromiseSettledResult<unknown>;
	alignmentResult: PromiseSettledResult<unknown> | null | undefined;
	params: {
		provider: string;
		model: string;
		organizationId?: string;
		onUsageTracked?: () => void;
	};
	executionTimeMs: number;
}): Promise<LLMEvalResult> {
	const {
		qualityResult,
		coherenceResult,
		alignmentResult,
		params,
		executionTimeMs,
	} = args;

	const buildMetric = (
		name: string,
		result: PromiseSettledResult<unknown>,
	): LLMMetricResult | null => {
		if (result.status !== "fulfilled") {
			// Log detailed error for debugging - helps diagnose Azure/provider issues
			const error = result.reason;
			let errorMessage: string;
			try {
				errorMessage =
					error instanceof Error
						? error.message
						: typeof error === "object"
							? JSON.stringify(error)
							: String(error);
			} catch {
				// JSON.stringify can fail on circular structures
				errorMessage =
					String(error) || "Unknown error (serialization failed)";
			}
			const errorStack = error instanceof Error ? error.stack : undefined;
			console.error(`[LLM Metrics] ${name} scorer FAILED:`, {
				error: errorMessage,
				stack: errorStack,
				provider: params.provider,
				model: params.model,
				// Log additional context for Azure/provider debugging
				hint:
					params.provider === "AZURE_AI_FOUNDRY"
						? "Azure AI Foundry scorer failure - check deployment name, API version, and endpoint URL"
						: "Check model configuration and API key",
			});
			return null;
		}
		const value = result.value as {
			score?: number;
			analyzeStepResult?: Record<string, unknown>;
		};
		const details = value.analyzeStepResult ?? {};
		// Log successful score for debugging
		console.log(`[LLM Metrics] ${name} scorer completed:`, {
			score: value.score ?? 0,
			hasDetails: Object.keys(details).length > 0,
		});
		return {
			name,
			score: value.score ?? 0,
			reasoning: (details.reasoning as string) ?? "",
			details,
		};
	};

	const quality = buildMetric("quality", qualityResult);
	const coherence = buildMetric("coherence", coherenceResult);
	const alignment = alignmentResult
		? buildMetric("alignment", alignmentResult)
		: null;

	const scores = [quality?.score, coherence?.score, alignment?.score].filter(
		(score): score is number => typeof score === "number",
	);

	const overallScore =
		scores.length > 0
			? Math.round(
					scores.reduce((sum, score) => sum + score, 0) /
						scores.length,
				)
			: 0;

	const metricsRun = [quality, coherence, alignment].filter(Boolean).length;
	const costUsd = estimateEvalCost(params.model) * metricsRun;

	if (params.organizationId && costUsd > 0) {
		await recordEvalCost({
			organizationId: params.organizationId,
			costUsd,
		});
	}

	params.onUsageTracked?.();

	return {
		quality,
		coherence,
		alignment,
		overallScore,
		executionTimeMs,
		costUsd,
		provider: params.provider,
		model: params.model,
	};
}

// =============================================================================
// Workflow-friendly wrapper activity
// =============================================================================

import { resolveEvalModel, toMastraModelConfig } from "./mastra-config";

/**
 * Input for the workflow-friendly LLM metrics activity
 * This activity handles model resolution internally, making it suitable
 * for use from Temporal workflows where model objects can't be serialized.
 */
export interface RunLLMMetricsWorkflowInput {
	documentContent: string;
	documentType: string;
	expectedSections: string[];
	userPrompt?: string;
	userId: string;
	organizationId?: string;
}

/**
 * Workflow-friendly LLM metrics activity.
 * Resolves the model internally rather than receiving it as a parameter,
 * making it suitable for use from Temporal workflows.
 */
export async function runLLMMetricsActivity(
	input: RunLLMMetricsWorkflowInput,
): Promise<LLMEvalResult | null> {
	const {
		documentContent,
		documentType,
		expectedSections,
		userPrompt,
		userId,
		organizationId,
	} = input;

	console.log("[LLM Metrics Activity] Starting with input:", {
		documentType,
		contentLength: documentContent?.length,
		expectedSectionsCount: expectedSections?.length,
		hasUserPrompt: !!userPrompt,
		userId,
		organizationId,
	});

	// Resolve the LLM model for EVAL task
	const llmModel = await resolveEvalModel({ userId, organizationId });

	if (!llmModel?.model) {
		console.log(
			"[LLM Metrics Activity] No LLM model configured - skipping",
		);
		return null;
	}

	console.log("[LLM Metrics Activity] Model resolved:", {
		provider: llmModel.metadata.provider,
		model: llmModel.metadata.modelString,
	});

	// Run the actual LLM metrics
	const result = await runLLMMetrics({
		documentContent,
		documentType,
		expectedSections,
		userPrompt,
		provider: llmModel.metadata.provider,
		model: llmModel.metadata.modelString,
		modelConfig: toMastraModelConfig(llmModel.model),
		organizationId,
		onUsageTracked: llmModel.trackUsage,
	});

	// Log result summary for debugging
	console.log("[LLM Metrics Activity] Result:", {
		hasResult: !!result,
		quality: result?.quality?.score ?? "null",
		coherence: result?.coherence?.score ?? "null",
		alignment: result?.alignment?.score ?? "null",
		overallScore: result?.overallScore,
		executionTimeMs: result?.executionTimeMs,
		allScorersNull:
			result &&
			result.quality === null &&
			result.coherence === null &&
			result.alignment === null,
	});

	// If all scorers failed, log a warning with hints
	if (
		result &&
		result.quality === null &&
		result.coherence === null &&
		result.alignment === null
	) {
		console.warn(
			"[LLM Metrics Activity] ⚠️ ALL SCORERS RETURNED NULL - Check error logs above for details.",
			{
				provider: llmModel.metadata.provider,
				model: llmModel.metadata.modelString,
				hint:
					llmModel.metadata.provider === "AZURE_AI_FOUNDRY"
						? "For Azure: verify deployment name, API version (2025-01-01-preview), and endpoint URL are correct"
						: "Check API key and model availability",
			},
		);
	}

	return result;
}
