import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/client";
import {
	AIProviderNotConfiguredError,
	generateObject,
	getAIModelWithMetadata,
	NoObjectGeneratedError,
	zodSchema,
} from "@repo/ai";
import { computeScaledOutputTokenBudget } from "@repo/ai/lib/output-token-budget";
import { db, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { AiReadinessResultSchema } from "./schemas";

type CachedEvaluation = {
	result: z.infer<typeof AiReadinessResultSchema>;
	specHash: string;
	timestamp: number;
};

const readinessCache = new Map<string, CachedEvaluation>();

// Clears detailed specs whole; raising higher eats into context margin on small-context models.
const SPEC_FIELD_CHAR_LIMIT = 30_000;
const ENGINEERING_CONTEXT_CHAR_LIMIT = 10_000;

const BUG_READINESS_RUBRIC = `
BUG READINESS RUBRIC:
- Assess whether engineering and QA can begin investigating and verifying the fix.
- Evaluate the bug Overview, Steps to Reproduce, Expected Result, Actual Result, and Fix Verification criteria.
- Evaluate supporting triage context when present: severity/priority, affected area, environment, frequency, evidence/error messages, user/business impact, and workaround.
- Treat environment and evidence as supporting context, not automatic blockers. Flag them only when their absence prevents meaningful reproduction or investigation.
- A bug does NOT require a feature story, use cases, feature scope, functional requirements, or feature Acceptance Criteria. Never list those feature-only elements as bug gaps.
- Call a missing section a gap only when its information cannot be inferred elsewhere in the ticket.
`;

const FEATURE_READINESS_RUBRIC = `
FEATURE / USER STORY READINESS RUBRIC:
- Assess whether product intent is sufficiently clear and testable for sprint execution.
- Evaluate the feature narrative or user outcome, scope and boundaries, functional requirements, user flows, acceptance criteria, business rules, and product-relevant edge cases.
- Flag missing acceptance criteria when the intended behavior is not otherwise testable.
- Do not require bug-only sections such as Steps to Reproduce, Expected Result, Actual Result, environment, or severity.
`;

const ENGINEERING_SECTION_PATTERN =
	/^(?:dev(?:eloper)? investigation items?|dev notes?|engineering (?:notes?|tasks?|investigation)|technical (?:notes?|discovery)|spikes?)(?:\s*\([^)]*\))?$/i;

const PRODUCT_SECTION_PATTERN =
	/^(?:acceptance criteria|fix verification|feature narrative|feature story|overview|benefit hypothesis|scope|in scope|out of scope|key decisions|use cases?|requirements|functional requirements|business rules|user flows?|open questions?|assumptions|dependencies|data & validation rules|permissions(?: \/ roles)?|non-functional requirements|bug metadata|triage assessment|steps to reproduce|expected result|actual result|environment|attachments \/ evidence|impact assessment|original description from user|needs more info|supporting questions|context & related signals|likely root cause hypotheses|requirements ↔ code mismatch|pm\/ba blocking gaps|updates from re-analysis|release planning|release notes|source index)(?:\s*\([^)]*\))?$/i;

type ReadinessQuestion = {
	impactedSection: string | null;
	topic: string | null;
	summary: string | null;
};

function normalizedHeading(value: string): string {
	return value
		.replace(/^\s*#+\s*/, "")
		.replace(/^[*_`:\s]+/g, "")
		.replace(/[*_`:\s]+$/g, "")
		.trim();
}

export function isEngineeringReadinessQuestion(
	question: ReadinessQuestion,
): boolean {
	const section = question.impactedSection
		? normalizedHeading(question.impactedSection)
		: "";
	if (ENGINEERING_SECTION_PATTERN.test(section)) {
		return true;
	}

	// Older decision-log rows may not have impactedSection populated. Only
	// accept an explicit label at the start; broad keyword matching would hide
	// legitimate product questions that happen to mention implementation.
	const label = normalizedHeading(question.topic || question.summary || "");
	return /^(?:dev investigation|dev note|engineering (?:note|task|investigation)|technical discovery|spike)\b/i.test(
		label,
	);
}

export function partitionReadinessSections(markdown: string): {
	product: string;
	engineering: string;
} {
	const lines = markdown.split("\n");
	const product: string[] = [];
	const engineering: string[] = [];
	let excludedHeadingLevel: number | null = null;

	for (const line of lines) {
		const markdownHeading = /^(\s*)(#{1,6})\s+(.+?)\s*$/.exec(line);
		const boldHeading = /^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*:?\s*$/.exec(
			line,
		);
		const headingTitle = markdownHeading?.[3] ?? boldHeading?.[1];
		if (headingTitle) {
			// A standalone bold label has no Markdown hierarchy. Treat it as a
			// section boundary that ends at the next heading or standalone label.
			const level = markdownHeading ? markdownHeading[2].length : 7;
			const title = normalizedHeading(headingTitle);

			if (
				excludedHeadingLevel !== null &&
				(level <= excludedHeadingLevel ||
					PRODUCT_SECTION_PATTERN.test(title))
			) {
				excludedHeadingLevel = null;
			}
			if (ENGINEERING_SECTION_PATTERN.test(title)) {
				excludedHeadingLevel = level;
			}
		}

		(excludedHeadingLevel === null ? product : engineering).push(line);
	}

	return {
		product: product.join("\n").trim(),
		engineering: engineering.join("\n").trim(),
	};
}

export function stripEngineeringReadinessSections(markdown: string): string {
	return partitionReadinessSections(markdown).product;
}

export function getAiReadinessTierLabel(score: number): string {
	if (score >= 100) {
		return "Fully Ready";
	}
	if (score >= 75) {
		return "Nearly Ready";
	}
	if (score >= 50) {
		return "In Progress";
	}
	if (score >= 25) {
		return "Early Maturation";
	}
	return "Not Ready";
}

const AiReadinessLlmSchema = z.object({
	aiReadinessScore: z.preprocess((val) => {
		if (typeof val === "string" && /^\d+$/.test(val.trim())) {
			return Number.parseInt(val.trim(), 10);
		}
		return val;
	}, z.number().min(0).max(100)),
	rationale: z.string(),
	strengths: z
		.array(z.string())
		.nullish()
		.transform((val) => val ?? []),
	gaps: z
		.array(z.string())
		.nullish()
		.transform((val) => val ?? []),
});

/**
 * `maturation.evaluateAiReadiness` — Isolated oRPC procedure that computes
 * an AI-assessed spec readiness score via `@repo/ai` LLM execution.
 *
 * Direct LLM Reasoning: Calls `getAIModelWithMetadata` + `generateObject` with full
 * specification context. Scoped strictly to description, acceptance criteria, and
 * decision log question threads (evaluating text completeness without assuming external fixtures).
 *
 * PM-SYNC & QA ISOLATION (§7.7): This procedure is purely read-only and
 * completely decoupled from `qaAnalysis` and database schema changes.
 */
export const evaluateAiReadinessProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.STORY_READ))
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/maturation/evaluate-ai-readiness",
		tags: ["Projects", "Features", "Maturation"],
		summary: "Evaluate AI-assessed specification readiness score",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(z.object({ aiReadiness: AiReadinessResultSchema }))
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// 1. Authorize project access first
		const canAccess = await hasProjectAccess(
			input.projectId,
			context.user.id,
			organizationId,
		);
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// 2. Fetch user story by storyId strictly scoped to projectId
		const story = await db.userStory.findFirst({
			where: { id: input.storyId, projectId: input.projectId },
			select: {
				id: true,
				projectId: true,
				kind: true,
				title: true,
				description: true,
				acceptanceCriteria: true,
				createdAt: true,
				lastEditedAt: true,
				project: {
					select: { organizationId: true },
				},
				decisionLogEntries: {
					where: {
						parentId: null,
						deletedAt: null,
						...(organizationId
							? { organizationId }
							: {
									organizationId: null,
									userId: context.user.id,
								}),
					},
					select: {
						id: true,
						status: true,
						topic: true,
						summary: true,
						impactedSection: true,
						questionId: true,
					},
				},
			},
		});

		if (!story) {
			throw new ORPCError("NOT_FOUND", {
				message: "Feature story not found",
			});
		}

		// Categorize question thread statuses cleanly
		const openQuestions =
			story.decisionLogEntries?.filter(
				(e) =>
					e.impactedSection !== "AI Updates" &&
					e.questionId != null &&
					e.status === "OPEN",
			) ?? [];
		const resolvedQuestions =
			story.decisionLogEntries?.filter(
				(e) =>
					e.impactedSection !== "AI Updates" &&
					e.questionId != null &&
					(e.status === "RESOLVED" ||
						e.status === "POSSIBLY_RESOLVED"),
			) ?? [];
		const productOpenQuestions = openQuestions.filter(
			(question) => !isEngineeringReadinessQuestion(question),
		);
		const engineeringOpenQuestions = openQuestions.filter(
			isEngineeringReadinessQuestion,
		);

		const semanticUpdatedAt = story.lastEditedAt ?? story.createdAt;
		const isRecentlyUpdated =
			Date.now() - semanticUpdatedAt.getTime() <=
			15 * 24 * 60 * 60 * 1000;

		// Idempotent replay: a double-fire within 60s on an unchanged spec returns stored evaluation
		const cacheKey = `${story.id}:${organizationId ?? context.user.id}`;
		const specContent = `${story.id}|${story.kind}|${story.title}|${story.description ?? ""}|${story.acceptanceCriteria ?? ""}|${openQuestions.map((q) => q.topic || q.summary || "").join(",")}|${resolvedQuestions.map((q) => q.topic || q.summary || "").join(",")}`;
		const specHash = createHash("sha256").update(specContent).digest("hex");
		const cached = readinessCache.get(cacheKey);

		if (cached) {
			if (Date.now() - cached.timestamp >= 60_000) {
				readinessCache.delete(cacheKey);
			} else if (cached.specHash === specHash) {
				return { aiReadiness: cached.result };
			}
		}

		// 3. Real LLM Reasoning Model via @repo/ai
		try {
			const aiOrgId =
				story.project?.organizationId ?? organizationId ?? undefined;
			const { model, metadata } = await getAIModelWithMetadata(
				{ taskType: "COMPLEX" },
				{
					userId: context.user.id,
					organizationId: aiOrgId,
					featureKey: "maturation",
				},
			);

			const isBug = story.kind === "BUG";
			const readinessRubric = isBug
				? BUG_READINESS_RUBRIC
				: FEATURE_READINESS_RUBRIC;
			const partitionedDescription = partitionReadinessSections(
				story.description ?? "",
			);
			const productDescription = partitionedDescription.product;
			const sanitizedDescription = productDescription
				? productDescription.length > SPEC_FIELD_CHAR_LIMIT
					? `${productDescription.slice(0, SPEC_FIELD_CHAR_LIMIT)}\n...[description truncated for evaluation]`
					: productDescription
				: "(None provided)";
			const sanitizedEngineeringContext =
				partitionedDescription.engineering
					? partitionedDescription.engineering.length >
						ENGINEERING_CONTEXT_CHAR_LIMIT
						? `${partitionedDescription.engineering.slice(0, ENGINEERING_CONTEXT_CHAR_LIMIT)}\n...[engineering context truncated]`
						: partitionedDescription.engineering
					: "None";

			const sanitizedAcceptanceCriteria = story.acceptanceCriteria
				? story.acceptanceCriteria.length > SPEC_FIELD_CHAR_LIMIT
					? `${story.acceptanceCriteria.slice(0, SPEC_FIELD_CHAR_LIMIT)}\n...[acceptance criteria truncated for evaluation]`
					: story.acceptanceCriteria
				: "(None provided)";

			const prompt = `
You are an expert Agile Product Manager evaluating a software ${isBug ? "bug ticket" : "user story specification"}.
Analyze the specification readiness for sprint execution based on the provided title, description, acceptance criteria, and decision log questions.

Work Item Kind: ${story.kind}
Work Item Title: ${story.title}
Work Item Description: ${sanitizedDescription}
Acceptance Criteria / Fix Criteria: ${sanitizedAcceptanceCriteria}
Last genuine edit (or creation when never edited): ${semanticUpdatedAt.toISOString()} (${isRecentlyUpdated ? "Changed within last 15 days" : "NOT changed in last 15 days — STALE"})
Unresolved Product Question Threads (${productOpenQuestions.length}): ${productOpenQuestions.map((q) => q.topic || q.summary || "Question").join("; ") || "None"}
Resolved Question Threads (${resolvedQuestions.length}): ${resolvedQuestions.map((q) => q.topic || q.summary || "Question").join("; ") || "None"}

NON-SCOREABLE ENGINEERING CONTEXT — REFERENCE ONLY:
Use this block only to understand what Product has delegated, deferred, or already recognized as implementation work. Its contents must never lower the readiness score, appear in gaps, or be treated as unresolved product requirements.
Dev / Engineering Sections:
${sanitizedEngineeringContext}
Engineering Investigation Threads (${engineeringOpenQuestions.length}): ${engineeringOpenQuestions.map((q) => q.topic || q.summary || "Engineering investigation").join("; ") || "None"}
END NON-SCOREABLE ENGINEERING CONTEXT

${readinessRubric}

CRITICAL RESTRICTION RULES:
- NEVER mention "Design links", "API links", "Figma links", "API contracts", "Swagger docs", or "test data placeholders" in Gaps or Rationale.
- Evaluate ONLY the text in the provided Work Item Description, Acceptance/Fix Criteria, and Decision Log Questions.
- Focus Gaps strictly on missing product behavior, undefined product edge cases, missing user-flow details, or unresolved PRODUCT question threads.
- SEPARATE PRODUCT GAPS FROM ENGINEERING TASKS: Do NOT flag technical discovery, codebase lookups, or implementation details as gaps. These are engineering tasks, not product specification failures.
- DEV INVESTIGATION ITEMS ARE NOT PRODUCT GAPS: Do not deduct points for items under explicitly engineering-labeled sections such as "Dev Investigation Items", "Engineering Investigation", "Technical Discovery", or "Spikes", or for questions about where/how to change code. A generic "Implementation Notes" or "Implementation Details" heading is not automatically engineering-only; evaluate its contents by meaning.
- EXPLICIT DEFERRALS ARE NOT GAPS: If the spec explicitly delegates a decision to engineering (e.g., "deferred to engineering discretion") or branches based on an existing backend pattern (e.g., "if system soft-deletes do X, else Y"), consider the product requirement RESOLVED.
- EXPLICITLY ACCEPTED ALTERNATIVES ARE RESOLVED: If Product deliberately permits two or more outcomes (e.g., "either skip scoring or show an unsupported-type message"), do not demand one authoritative option. Flag alternatives only when the spec does not accept them all and choosing between them is necessary to satisfy the stated product outcome.
- OUT-OF-SCOPE MEANS DO NOT SCORE: Treat explicit Out of Scope items as deliberate boundaries. Never deduct points or request behavior, edge cases, or acceptance criteria for them.
- EXISTING CAPABILITIES ARE SATISFIED CONTEXT: When the spec says a capability already exists, is preserved, or is a prerequisite, do not ask how/where it is implemented and do not require new acceptance criteria for that existing behavior unless this feature changes it.
- READ THE WHOLE SPEC BEFORE CLAIMING A GAP: Do not flag information as missing when it is answered elsewhere in the description, requirements, key decisions, use cases, acceptance criteria, or stated prerequisites.
- DO NOT INVENT REQUIREMENTS: Do not request additional UI indicators, messages, workflows, controls, or acceptance criteria when the explicitly required outcome is already testable. A potential enhancement is not a readiness gap unless it is necessary to execute or verify a stated product requirement.
- DETECT PRODUCT CONTRADICTIONS: Flag two or more explicit, simultaneously applicable product requirements that prescribe incompatible outcomes. In the gap, name both conflicting behaviors and the sections where they appear.
- DO NOT INVENT CONTRADICTIONS: Current behavior versus explicitly desired future behavior is a change, not a contradiction. Neither are role-specific behavior, conditional branches, phased rollout, fallback behavior, engineering alternatives, explicit deferrals, or out-of-scope boundaries unless the statements truly apply under the same conditions and cannot both be satisfied.

Instructions:
1. Dynamically evaluate requirement clarity, acceptance testability, and question resolutions.
2. Classify every possible gap as PRODUCT or ENGINEERING before scoring. Only PRODUCT gaps may reduce the score or appear in the gaps output.
3. If unresolved Product Question Threads exist, weigh them heavily as gaps and deduct readiness points. Engineering Investigation Threads must not reduce the score.
4. Do not deduct points or list gaps for items explicitly categorized as "Dev Investigation Items" or similar technical lookups, even if they are unresolved or phrased as questions.
5. For each candidate PRODUCT gap, search the entire supplied spec for an answer, an accepted alternative, an explicit deferral, an out-of-scope declaration, or an existing/prerequisite capability. Discard the candidate if any is found.
6. Check for direct contradictions between simultaneously applicable product requirements. Treat a confirmed contradiction as a PRODUCT gap and identify both source sections concisely.
7. If the specification has not been updated within 15 days, cap the maximum score at 95% and flag it as stale in the gaps list.
8. Compute an overall readiness score as an integer number from 0 to 100.
9. Provide a concise 1-sentence rationale (max 15 words).
10. Provide 1-2 concise, punchy bullet points for strengths (return [] if none).
11. Provide 1-2 concise, punchy bullet points for gaps (return [] if none). Ensure gaps are purely product-facing.
`;

			const maxOutputTokens = computeScaledOutputTokenBudget(metadata, {
				inputChars: 0,
				promptChars: prompt.length,
			});

			let attempts = 0;
			let rawObject: z.infer<typeof AiReadinessLlmSchema> | undefined;

			while (attempts < 2) {
				attempts++;
				try {
					const { object } = await generateObject({
						model,
						schema: zodSchema(AiReadinessLlmSchema),
						prompt,
						maxOutputTokens,
						providerOptions: {
							openai: { strictJsonSchema: false },
						},
					});
					rawObject = object;
					break;
				} catch (err) {
					if (
						NoObjectGeneratedError.isInstance(err) &&
						err.finishReason !== "length" &&
						attempts < 2
					) {
						continue;
					}
					throw err;
				}
			}

			if (!rawObject) {
				throw new Error("Failed to generate AI readiness evaluation");
			}

			const object: z.infer<typeof AiReadinessResultSchema> = {
				aiReadinessScore: rawObject.aiReadinessScore,
				tierLabel: getAiReadinessTierLabel(rawObject.aiReadinessScore),
				rationale: rawObject.rationale,
				strengths: rawObject.strengths,
				gaps: rawObject.gaps,
			};

			if (readinessCache.size >= 100) {
				const oldestKey = readinessCache.keys().next().value;
				if (oldestKey) {
					readinessCache.delete(oldestKey);
				}
			}
			readinessCache.set(cacheKey, {
				result: object,
				specHash,
				timestamp: Date.now(),
			});
			return { aiReadiness: object };
		} catch (err) {
			console.error("[evaluateAiReadiness] LLM execution failed:", err);

			if (err instanceof AIProviderNotConfiguredError) {
				throw new ORPCError("SERVICE_UNAVAILABLE", {
					message:
						"No AI provider is configured. Add one in Settings → AI Providers to score readiness.",
				});
			}

			if (NoObjectGeneratedError.isInstance(err)) {
				if (err.finishReason === "length") {
					throw new ORPCError("SERVICE_UNAVAILABLE", {
						message:
							"The model ran out of output budget before returning a score. Please try again.",
					});
				}
				throw new ORPCError("SERVICE_UNAVAILABLE", {
					message:
						"AI model output could not be formatted into a readiness score. Please try again.",
				});
			}

			throw new ORPCError("SERVICE_UNAVAILABLE", {
				message:
					"AI readiness evaluation service is currently unavailable",
			});
		}
	});
