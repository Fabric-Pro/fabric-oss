import { ORPCError } from "@orpc/server";
import { hasProjectAccess } from "@repo/database";
import {
	formatContextsForPrompt,
	formatWizardContextsForPrompt,
	retrieveProjectContexts,
	retrieveWizardContexts,
} from "@repo/rag";
import { z } from "zod";
import { rethrowChatGptPlanRefusal } from "../../../lib/chatgpt-plan-errors";
import {
	assertProjectPermission,
	authorizeInputOrganization,
	Permissions,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { loadProjectOrganizationId } from "../../projects/lib/project-organization";

/**
 * AUTHORIZATION: PROJECT_UPDATE, checked in the handler before any model or
 * RAG provider is resolved, against the tenant this call will run in. Which
 * check applies depends on the input, which is why it is not a middleware:
 *
 * - With `projectId` (the wizard's DRAFT project): the same project decision
 *   `requireProjectPermission` makes (`assertProjectPermission`), and the AI
 *   model, RAG provider and retrieval run in that project's organization. A
 *   project guest without membership of the project's organization keeps
 *   working, as they did when only the session organization's role was read.
 * - Without `projectId`: membership and the PROJECT_UPDATE role in the
 *   organization the input resolves to (`authorizeInputOrganization`, the
 *   check `requireInputOrgPermission` runs), not merely the session
 *   organization. `requireOrganization` refuses a request that resolves none:
 *   the organization is the only tenant context (ADR-018), and an explicit
 *   `organizationId: null` would otherwise skip the check.
 *
 * Either way `input.organizationId` alone never picks whose AI provider runs.
 */
export const refineDescriptionProcedure = tenantProtectedProcedure
	.route({
		method: "POST",
		path: "/wizard/refine-description",
		tags: ["Wizard", "AI"],
		summary: "Refine project description with AI",
		description:
			"Use AI to improve and refine a project description using RAG to retrieve relevant context from uploaded documents",
	})
	.input(
		z.object({
			/** Wizard session ID for RAG context retrieval (legacy WizardTempContext path) */
			sessionId: z.string().min(1, "Session ID is required"),
			description: z.string().min(1, "Description is required"),
			projectName: z.string().optional(),
			projectTypes: z.array(z.string()).optional(),
			/**
			 * DRAFT project ID for RAG retrieval against project-contexts collection.
			 * Set after the unified-context-uploader-wizard spec (2026-05-23): files
			 * added in the wizard write to `ProjectContext` on the DRAFT, indexed in
			 * the project-contexts Qdrant collection. Pass this so refine retrieves
			 * the same documents. Optional for backward compat with older clients.
			 */
			projectId: z.string().optional(),
			/** @deprecated Use sessionId / projectId for RAG retrieval instead */
			attachmentSummaries: z.array(z.string()).optional(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const {
			sessionId,
			description,
			projectName,
			projectTypes,
			projectId,
			attachmentSummaries,
		} = input;
		const user = context.user;

		// Authorize first; nothing below runs for a refused caller. The
		// organization used from here on is the one the applicable check
		// authorized.
		let organizationId: string;
		if (projectId) {
			await assertProjectPermission(
				projectId,
				user.id,
				Permissions.PROJECT_UPDATE,
				context,
			);
			organizationId = await loadProjectOrganizationId(projectId);
		} else {
			const authorized = await authorizeInputOrganization(
				Permissions.PROJECT_UPDATE,
				input.organizationId,
				context,
				{ requireOrganization: true },
			);
			if (!authorized) {
				// Unreachable: `requireOrganization` refuses an unresolved
				// organization. Fail closed if that ever stops being true.
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message:
						"Organization authorization resolved no organization",
				});
			}
			organizationId = authorized;
		}

		// Import AI utilities
		const {
			getAIModelWithMetadata,
			getEmbeddingRAGProviderConfig,
			logModelUsageAsync,
		} = await import("@repo/ai");

		// Use centralized single entry point for AI model access
		const { model, metadata, trackUsage } = await getAIModelWithMetadata(
			{ taskType: "SIMPLE" },
			{ userId: user.id, organizationId },
		);

		// Get RAG provider config for embedding operations
		const ragConfig = await getEmbeddingRAGProviderConfig({
			userId: user.id,
			organizationId,
		});

		// Track usage (fire-and-forget)
		trackUsage();

		// Use RAG to retrieve relevant context from uploaded documents.
		//
		// Two retrieval paths run in parallel (both optional, both best-effort):
		//
		//   1. Wizard-contexts (`retrieveWizardContexts`) — keyed by sessionId.
		//      Pre-2026-05-23 wizard files (WizardTempContext path) live here.
		//
		//   2. Project-contexts (`retrieveProjectContexts`) — keyed by projectId.
		//      Post-2026-05-23 wizard files (DRAFT-as-host pattern from the
		//      `unified-context-uploader-wizard` spec) live here. Only queried
		//      when projectId is provided AND access check passes.
		//
		// Results are merged and formatted. Wizard-context errors don't kill the
		// project-context path and vice versa. If BOTH return zero results AND
		// no RAG-level error occurred, we fall back to attachmentSummaries
		// (legacy client behavior). Any unexpected error in this block is logged
		// and we proceed without context rather than failing the refine.
		let ragContext = "";
		let retrievedContextCount = 0;
		let anyRagSucceeded = false;
		const formattedSections: string[] = [];

		// Path 2: project-contexts (DRAFT-as-host) — verify access first so a
		// client can't fish project IDs they don't own. Failure here is silent
		// (treated as "no project context"), since refine should degrade
		// gracefully rather than fail when context retrieval misbehaves.
		if (projectId) {
			try {
				const canAccess = await hasProjectAccess(
					projectId,
					user.id,
					organizationId,
				);
				if (canAccess) {
					const projectContexts = await retrieveProjectContexts({
						projectId,
						query: description,
						userId: user.id,
						organizationId,
						topK: 5,
						similarityThreshold: 0.5,
					});

					anyRagSucceeded = true;

					if (projectContexts.length > 0) {
						formattedSections.push(
							formatContextsForPrompt(projectContexts),
						);
						retrievedContextCount += projectContexts.length;
						console.log(
							`[RefineDescription] Retrieved ${projectContexts.length} project contexts via RAG (projectId=${projectId})`,
						);
					}
				} else {
					console.warn(
						`[RefineDescription] User ${user.id} lacks access to projectId=${projectId}; skipping project-context retrieval`,
					);
				}
			} catch (projectRagError) {
				console.warn(
					`[RefineDescription] Project-context retrieval failed: ${projectRagError}`,
				);
			}
		}

		// Path 1: wizard-contexts (legacy / pre-spec sessions)
		try {
			const wizardContexts = await retrieveWizardContexts({
				sessionId,
				query: description,
				userId: user.id,
				organizationId,
				topK: 5,
				similarityThreshold: 0.5,
				apiKey: {
					apiKey: ragConfig.apiKey,
					provider: ragConfig.provider ?? undefined,
				},
			});

			anyRagSucceeded = true;

			if (wizardContexts.length > 0) {
				formattedSections.push(
					formatWizardContextsForPrompt(wizardContexts),
				);
				retrievedContextCount += wizardContexts.length;
				console.log(
					`[RefineDescription] Retrieved ${wizardContexts.length} wizard contexts via RAG (sessionId=${sessionId})`,
				);
			}
		} catch (wizardRagError) {
			console.warn(
				`[RefineDescription] Wizard-context retrieval failed: ${wizardRagError}`,
			);
		}

		if (formattedSections.length > 0) {
			ragContext = `\n\n${formattedSections.join("\n\n")}`;
		} else if (attachmentSummaries && attachmentSummaries.length > 0) {
			// Fallback: client passed file-title summaries. Used when both
			// retrieval paths return zero results OR both threw. Catches the
			// post-spec case where the user's files are still mid-indexing
			// (extractionStatus !== COMPLETED) so RAG returns nothing yet but
			// the wizard knows the titles to hint at.
			ragContext = `\n\nContext from attached documents:\n${attachmentSummaries.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;
			console.log(
				`[RefineDescription] Falling back to ${attachmentSummaries.length} attachment summaries (anyRagSucceeded=${anyRagSucceeded})`,
			);
		}

		// Build project type context
		let projectTypeContext = "";
		if (projectTypes && projectTypes.length > 0) {
			projectTypeContext = `\nProject types: ${projectTypes.join(", ")}`;
		}

		// Build the prompt
		const systemPrompt = `You are a technical writer helping refine project descriptions.
Your task is to improve the given description to be:
- Clear and professional
- Well-structured with proper paragraphs
- Comprehensive but concise
- Focused on the project's purpose, goals, and key features

${ragContext ? "You have been provided with relevant context from uploaded documents. Use this context to enrich and improve the description while staying true to the original intent." : ""}

Do NOT add fabricated details or features not implied by the original description or provided context.
Keep the same general intent but make it more polished and professional.
Return ONLY the refined description text, no explanations or preamble.`;

		const userPrompt = `Please refine this project description${projectName ? ` for a project called "${projectName}"` : ""}${projectTypeContext}:

Original description:
${description}${ragContext}

Refined description:`;

		try {
			// Dynamic import to avoid circular dependencies
			const { generateText } = await import("ai");

			// Generate refined description using the centralized model
			const generationStart = Date.now();
			const result = await generateText({
				model,
				instructions: systemPrompt,
				prompt: userPrompt,
			});
			logModelUsageAsync({
				context: {
					userId: user.id,
					organizationId,
				},
				metadata,
				taskType: "SIMPLE",
				usage: result.usage,
				latencyMs: Date.now() - generationStart,
			});

			return {
				refinedDescription: result.text.trim(),
				originalDescription: description,
				contextUsed: retrievedContextCount > 0,
				contextCount: retrievedContextCount,
			};
		} catch (error) {
			rethrowChatGptPlanRefusal(error);
			console.error("Error refining description:", error);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Failed to refine description: ${error instanceof Error ? error.message : "Unknown error"}`,
			});
		}
	});
