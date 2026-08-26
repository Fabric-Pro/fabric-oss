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
			const sanitizedDescription = story.description
				? story.description.length > SPEC_FIELD_CHAR_LIMIT
					? `${story.description.slice(0, SPEC_FIELD_CHAR_LIMIT)}\n...[description truncated for evaluation]`
					: story.description
				: "(None provided)";

			const sanitizedAcceptanceCriteria = story.acceptanceCriteria
				? story.acceptanceCriteria.length > SPEC_FIELD_CHAR_LIMIT
					? `${story.acceptanceCriteria.slice(0, SPEC_FIELD_CHAR_LIMIT)}\n...[acceptance criteria truncated for evaluation]`
					: story.acceptanceCriteria
				: "(None provided)";

			const prompt = `
You are an expert Agile Product Manager evaluating a software ${isBug ? "bug ticket" : "user story specification"}.
Analyze the specification readiness for sprint execution based on the provided title, description, acceptance criteria, and decision log questions.

Work Item Kind: ${story.kind} (${isBug ? "BUG FIX — Evaluate readiness based on bug overview, reproduction steps, expected vs actual behavior, and fix criteria" : "FEATURE — Evaluate readiness based on functional requirements and user flow clarity"})
Work Item Title: ${story.title}
Work Item Description: ${sanitizedDescription}
Acceptance Criteria / Fix Criteria: ${sanitizedAcceptanceCriteria}
Last genuine edit (or creation when never edited): ${semanticUpdatedAt.toISOString()} (${isRecentlyUpdated ? "Changed within last 15 days" : "NOT changed in last 15 days — STALE"})
Open Question Threads (${openQuestions.length}): ${openQuestions.map((q) => q.topic || q.summary || "Question").join("; ") || "None"}
Resolved Question Threads (${resolvedQuestions.length}): ${resolvedQuestions.map((q) => q.topic || q.summary || "Question").join("; ") || "None"}

CRITICAL RESTRICTION RULES:
- NEVER mention "Design links", "API links", "Figma links", "API contracts", "Swagger docs", or "test data placeholders" in Gaps or Rationale.
- Evaluate ONLY the text in the provided Feature Description, Acceptance Criteria, and Decision Log Questions.
- Focus Gaps strictly on missing business logic, undefined edge cases, missing user flow details, or unresolved open question threads.
- SEPARATE PRODUCT GAPS FROM ENGINEERING TASKS: Do NOT flag technical discovery, codebase lookups, or implementation details as gaps. These are engineering tasks, not product specification failures.
- EXPLICIT DEFERRALS ARE NOT GAPS: If the spec explicitly delegates a decision to engineering (e.g., "deferred to engineering discretion") or branches based on an existing backend pattern (e.g., "if system soft-deletes do X, else Y"), consider the product requirement RESOLVED.

Instructions:
1. Dynamically evaluate requirement clarity, acceptance testability, and question resolutions.
2. If open question threads exist, weigh them heavily as gaps and deduct readiness points.
3. Do not deduct points or list gaps for items explicitly categorized as "Dev Investigation Items" or similar technical lookups.
4. If the specification has not been updated within 15 days, cap the maximum score at 95% and flag it as stale in the gaps list.
5. Compute an overall readiness score as an integer number from 0 to 100.
6. Provide a concise 1-sentence rationale (max 15 words).
7. Provide 1-2 concise, punchy bullet points for strengths (return [] if none).
8. Provide 1-2 concise, punchy bullet points for gaps (return [] if none). Ensure gaps are purely product-facing.
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
