import { ORPCError } from "@orpc/server";
import { getPromptById, incrementPromptUsage } from "@repo/database";
import { renderTemplate } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

export const renderProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.PROMPT_UPDATE))
	.route({
		method: "POST",
		path: "/prompts/:id/render",
		tags: ["Prompts"],
		summary: "Render a prompt with variables",
		description:
			"Render a prompt template with provided variables, inject context, and track usage",
	})
	.input(
		z.object({
			id: z.string(),
			variables: z.record(z.string(), z.any()).default({}),
			versionNumber: z.number().optional(), // If not provided, use latest version
			trackUsage: z.boolean().default(true),
			// Context injection for agent prompts
			projectContext: z
				.object({
					name: z.string(),
					description: z.string().optional(),
					goals: z.string().optional(),
					techStack: z.array(z.string()).default([]),
					features: z.array(z.string()).default([]),
					projectType: z.string().optional(),
				})
				.optional()
				.describe("Project context to inject into prompt"),
			ragContexts: z
				.array(z.string())
				.optional()
				.describe("RAG-retrieved knowledge to inject into prompt"),
			currentDocument: z
				.string()
				.optional()
				.describe("Current document state to inject into prompt"),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;

		// Get prompt with versions
		const prompt = await getPromptById(input.id);

		if (!prompt) {
			throw new ORPCError("NOT_FOUND", {
				message: "Prompt not found",
			});
		}

		// Authorization checks
		if (prompt.scope === "SYSTEM") {
			// System prompts are accessible to all authenticated users
		} else if (prompt.scope === "ORG") {
			// Verify organization membership
			if (!prompt.organizationId) {
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message: "Organization prompt missing organization ID",
				});
			}

			const membership = await verifyOrganizationMembership(
				prompt.organizationId,
				user.id,
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}
		} else if (prompt.scope === "USER") {
			// Only the owner can use user prompts (unless public)
			if (!prompt.isPublic && prompt.userId !== user.id) {
				throw new ORPCError("FORBIDDEN", {
					message: "You can only use your own private prompts",
				});
			}
		}

		// Get the appropriate version
		let version: (typeof prompt.versions)[0] | undefined;
		if (input.versionNumber !== undefined) {
			version = prompt.versions.find(
				(v) => v.version === input.versionNumber,
			);
			if (!version) {
				throw new ORPCError("NOT_FOUND", {
					message: `Version ${input.versionNumber} not found`,
				});
			}
		} else {
			// Use latest version
			version = prompt.versions[0];
			if (!version) {
				throw new ORPCError("NOT_FOUND", {
					message: "No versions found for this prompt",
				});
			}
		}

		// Render the base template with variables
		const result = await renderTemplate({
			format: prompt.format as any,
			template: version.content,
			variables: input.variables,
		});

		if (result.error) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Failed to render template: ${result.error}`,
			});
		}

		let finalRendered = result.rendered;

		// Inject project context if provided
		if (input.projectContext) {
			const projectInfo = `

Project Context:
- Name: ${input.projectContext.name}
${input.projectContext.description ? `- Description: ${input.projectContext.description}` : ""}
${input.projectContext.goals ? `- Goals: ${input.projectContext.goals}` : ""}
${input.projectContext.techStack.length > 0 ? `- Tech Stack: ${input.projectContext.techStack.join(", ")}` : ""}
${input.projectContext.features.length > 0 ? `- Features: ${input.projectContext.features.join(", ")}` : ""}
${input.projectContext.projectType ? `- Project Type: ${input.projectContext.projectType}` : ""}
`;
			finalRendered += projectInfo;
		}

		// Inject RAG contexts if provided
		if (input.ragContexts && input.ragContexts.length > 0) {
			const ragInfo = `

Retrieved Knowledge:
${input.ragContexts.map((ctx, i) => `${i + 1}. ${ctx}`).join("\n")}
`;
			finalRendered += ragInfo;
		}

		// Inject current document state if provided
		if (input.currentDocument) {
			const docInfo = `

Current Document State:
----
${input.currentDocument}
----
`;
			finalRendered += docInfo;
		}

		// Track usage if requested
		if (input.trackUsage) {
			await incrementPromptUsage(prompt.id);
		}

		return {
			rendered: finalRendered,
			error: result.error,
			version: version.version,
			format: prompt.format,
		};
	});
