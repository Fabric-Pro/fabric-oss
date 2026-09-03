import { StoryKindSchema } from "@repo/database";
import {
	getBoundPromptForAgent,
	listAvailablePromptsForAgent,
} from "@repo/database/prisma/queries/prompts";
import { logger } from "@repo/logs";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { resolveProjectForOrg } from "../lib/resolve-project-for-org";

/**
 * Get bound prompt for a specific agent and document type
 * Returns the prompt that is currently bound to the agent based on user/org/system precedence
 * REQUIRES documentType to ensure the correct prompt is returned for each document type
 *
 * IMPORTANT: organizationId must be explicitly passed for proper tenant isolation:
 * - Pass the org ID string when in organization context
 * - Pass null explicitly when in personal context
 *
 * SCOPE — this is a prompt-LIBRARY read, not a work-item routing surface, and
 * that distinction was reviewed and kept deliberately (Fizzy #2048).
 *
 * It takes `agentName` and `storyKind` as free input and receives no work item
 * id, so it cannot check that the pair it is asked for matches any particular
 * item. That used to matter: the work item detail view called this to decide
 * which template to run, which meant a stale cached kind picked the template.
 * Those callers now go through `projects.stories.resolvePrompt`, which takes the
 * item and derives the kind from the stored row.
 *
 * What remains here is a caller reading a prompt out of the catalog by name —
 * which is what the prompt-management UI legitimately does. It is gated on
 * PROMPT_READ and tenant-scoped, so the worst a caller can do is read a prompt
 * it was already entitled to read, under a name of its choosing.
 *
 * Do NOT "harden" this by adding a story id: that would merge two different
 * jobs into one procedure and give the library UI a work item it has no reason
 * to supply. If a NEW caller needs a prompt for a specific work item, it belongs
 * on `resolvePrompt`, not here.
 */
const getBoundPromptProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.PROMPT_READ))
	.input(
		z.object({
			agentName: z
				.string()
				.describe("Agent name (e.g., 'project_document_generator')"),
			documentType: z
				.string()
				.min(1, "Document type is required")
				.describe(
					"Document type (e.g., 'PRD', 'ARCHITECTURE', 'API_SPEC')",
				),
			storyKind: StoryKindSchema.nullable()
				.optional()
				.describe(
					"Kind discriminator for stage bindings. Pass FEATURE/BUG to scope to that kind's prompt; pass null for non-stage bindings; omit to match any kind (legacy behavior).",
				),
			organizationId: z
				.string()
				.nullable()
				.optional()
				.describe(
					"Organization ID for tenant isolation. Pass null for personal context.",
				),
		}),
	)
	.output(
		z
			.object({
				id: z.string(),
				key: z.string(),
				name: z.string(),
				description: z.string().nullable(),
				scope: z.enum(["SYSTEM", "ORG", "USER"]),
				format: z.string(),
				category: z.string().nullable(),
				tags: z.array(z.string()),
				version: z.object({
					id: z.string(),
					version: z.number(),
					content: z.string(),
					variables: z.any(),
				}),
			})
			.nullable(),
	)
	.handler(async ({ input, context }) => {
		const { agentName, documentType, storyKind } = input;
		const { user, session } = context;

		// Use resolveOrganizationId for proper tenant isolation
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		const prompt = await getBoundPromptForAgent({
			agentName,
			userId: user.id,
			organizationId,
			documentType,
			storyKind,
		});

		logger.info("[prompts.agents.bound] resolved", {
			agentName,
			documentType,
			storyKind: storyKind ?? null,
			promptKey: prompt?.key ?? null,
			promptScope: prompt?.scope ?? null,
			resolved: prompt !== null,
		});

		return prompt;
	});

/**
 * List all available prompts for an agent (for UI dropdown)
 * Includes system, org, and user prompts with binding status
 *
 * IMPORTANT: organizationId must be explicitly passed for proper tenant isolation:
 * - Pass the org ID string when in organization context
 * - Pass null explicitly when in personal context
 */
const listAvailablePromptsProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.PROMPT_READ))
	.input(
		z.object({
			agentName: z
				.string()
				.describe("Agent name (e.g., 'project_document_generator')"),
			documentType: z
				.string()
				.optional()
				.describe("Optional document type filter"),
			storyKind: StoryKindSchema.nullable()
				.optional()
				.describe(
					"Kind discriminator for stage bindings. Pass FEATURE/BUG to scope to that kind's prompts; pass null for non-stage bindings; omit to return all kinds.",
				),
			organizationId: z
				.string()
				.nullable()
				.optional()
				.describe(
					"Organization ID for tenant isolation. Pass null for personal context.",
				),
			projectId: z
				.string()
				.nullable()
				.optional()
				.describe(
					"When generating inside a project, that project's id. Its PROJECT-tier prompt joins the list and can be the one marked default, matching what the agent resolves there. Must belong to the organization.",
				),
		}),
	)
	.output(
		z.object({
			prompts: z.array(
				z.object({
					id: z.string(),
					key: z.string(),
					name: z.string(),
					description: z.string().nullable(),
					scope: z.enum(["SYSTEM", "ORG", "USER"]),
					category: z.string().nullable(),
					tags: z.array(z.string()),
					forkedFrom: z
						.object({
							id: z.string(),
							key: z.string(),
							name: z.string(),
							scope: z.enum(["SYSTEM", "ORG", "USER"]),
						})
						.nullable()
						.describe("Parent prompt if this was forked"),
					isBound: z
						.boolean()
						.describe(
							"Whether this prompt is currently bound to the agent",
						),
					isDefault: z
						.boolean()
						.describe(
							"Whether this prompt is the default for this document type",
						),
					contentSnippet: z
						.string()
						.describe(
							"First ~200 characters of the prompt content for preview",
						),
					latestVersion: z
						.object({
							id: z.string(),
							version: z.number(),
						})
						.nullable(),
				}),
			),
		}),
	)
	.handler(async ({ input, context }) => {
		const { agentName, documentType, storyKind } = input;
		const { user, session } = context;

		// Use resolveOrganizationId for proper tenant isolation
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		const projectId = await resolveProjectForOrg(
			input.projectId,
			organizationId,
		);

		const prompts = await listAvailablePromptsForAgent({
			agentName,
			userId: user.id,
			organizationId,
			documentType,
			storyKind,
			projectId,
		});

		logger.info("[prompts.agents.available] resolved", {
			agentName,
			documentType: documentType ?? null,
			storyKind: storyKind ?? null,
			count: prompts.length,
			keys: prompts.map((p) => p.key),
		});

		return { prompts };
	});

/**
 * Resolve the clarifying-question frequency policy for a tier.
 *
 * Returns the editable SYSTEM/ORG prompt content bound to the
 * `clarifying_questions` agent at the given tier (documentType = MINIMAL |
 * BALANCED | THOROUGH), or `null` if none is seeded — in which case the caller
 * falls back to a built-in default. Deliberately gated by auth/tenant only
 * (NOT PROMPT_READ): the clarifying-question card must work for every user with
 * project access, not only those who can browse the Prompt Library. The content
 * is a behavioral instruction, not sensitive data.
 */
const getClarifyingPolicyProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.PROMPT_READ))
	.input(
		z.object({
			frequency: z
				.enum(["MINIMAL", "BALANCED", "THOROUGH"])
				.describe("Clarifying-question frequency tier."),
			organizationId: z
				.string()
				.nullable()
				.optional()
				.describe(
					"Organization ID for tenant isolation. Pass null for personal context.",
				),
		}),
	)
	.output(z.object({ policy: z.string().nullable() }))
	.handler(async ({ input, context }) => {
		const { frequency } = input;
		const { user, session } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		const prompt = await getBoundPromptForAgent({
			agentName: "clarifying_questions",
			documentType: frequency,
			storyKind: null,
			userId: user.id,
			organizationId,
		});

		const policy = prompt?.version?.content?.trim() || null;
		return { policy };
	});

export const agentsProcedures = {
	bound: getBoundPromptProcedure,
	available: listAvailablePromptsProcedure,
	clarifyingPolicy: getClarifyingPolicyProcedure,
};
