import { ORPCError } from "@orpc/client";
import { type Prisma, upsertDraftProjectByKey } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

/**
 * AUTHORIZATION: Verifies org membership if in org context.
 * Creates or updates a DRAFT project identified by a client-generated draftKey.
 * Idempotent: calling multiple times with the same draftKey upserts the draft.
 *
 * Wizard-only ephemera (selections, currentStep, customRequirements) is stored
 * atomically in the `wizardState` JSON blob. Production-meaningful fields
 * (repositoryUrl, projectManagementMcp*) are written to their typed columns.
 */
export const saveDraftProjectProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/draft",
		tags: ["Projects"],
		summary: "Save draft project",
		description:
			"Idempotently create or update a DRAFT project by draftKey",
	})
	.input(
		z.object({
			draftKey: z.string().uuid(),
			name: z.string().min(1).max(255),
			organizationId: z.string().nullable().optional(),
			// Typed columns — persisted directly
			description: z.string().max(5000).optional(),
			techStack: z.array(z.string()).optional(),
			features: z.array(z.string()).optional(),
			projectTypes: z.array(z.string()).optional(),
			tags: z.array(z.string()).optional(),
			icon: z.string().optional(),
			color: z.string().optional(),
			goals: z.string().max(5000).optional(),
			// Repository connection (typed columns; meaningful post-activation)
			repositoryUrl: z.string().nullable().optional(),
			repositoryOwner: z.string().nullable().optional(),
			repositoryName: z.string().nullable().optional(),
			defaultBranch: z.string().nullable().optional(),
			// PM integration (typed columns; meaningful post-activation)
			projectManagementMcpServerId: z.string().nullable().optional(),
			projectManagementMcpConfigId: z.string().nullable().optional(),
			projectManagementContainerId: z.string().nullable().optional(),
			projectManagementContainerName: z.string().nullable().optional(),
			projectManagementAdditionalContext: z
				.record(z.string(), z.unknown())
				.nullable()
				.optional(),
			// Wizard-only ephemera — bundled into wizardState JSON blob, nulled on activation.
			// Loose schemas (z.record/z.unknown) keep the server tolerant to client-side
			// type evolution; the server doesn't introspect these, only round-trips them.
			currentStep: z.number().int().min(1).max(5).optional(),
			customRequirements: z.string().max(5000).optional(),
			documents: z.array(z.string()).optional(),
			tempContextIds: z.array(z.string()).optional(),
			wizardSessionId: z.string().optional(),
			selectedTeamsChats: z.array(z.unknown()).optional(),
			selectedNotionPages: z.array(z.unknown()).optional(),
			selectedSlackChannels: z.array(z.unknown()).optional(),
			selectedGitHubRepos: z.array(z.unknown()).optional(),
			selectedGitLabRepos: z.array(z.unknown()).optional(),
			// Azure DevOps repo metadata only — the PAT is NEVER persisted to the
			// draft (it lives transiently in the wizard's `azureDevOpsCredsRef`,
			// spec §6). Round-tripped via wizardState so a resumed DRAFT restores
			// the selected ADO repos in the unified Repository card.
			selectedAzureDevOpsRepos: z.array(z.unknown()).optional(),
			// Unified-project-setup wizard ephemera (round-tripped via wizardState
			// so a resumed DRAFT restores the optional Backlog/Repository cards,
			// website URLs, and per-document prompts). Loose schemas keep the
			// server tolerant to client-side type evolution.
			codebaseRepoUrls: z.array(z.string()).optional(),
			primaryWebsiteUrl: z.string().optional(),
			additionalWebsiteUrls: z.array(z.string()).optional(),
			projectManagementDetectedType: z.string().nullable().optional(),
			documentPrompts: z.record(z.string(), z.unknown()).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		try {
			const organizationId = resolveOrganizationId(
				input.organizationId,
				context.session,
			);

			if (organizationId) {
				const membership = await verifyOrganizationMembership(
					organizationId,
					context.user.id,
				);
				if (!membership) {
					throw new ORPCError("FORBIDDEN", {
						message: "You are not a member of this organization",
					});
				}
			}

			// Bundle wizard-only fields into a single JSON blob. Only fields
			// the client actually sent are included; missing fields are absent
			// from the blob (the blob is always a full snapshot of "what the
			// client knows right now", overwritten atomically on each save).
			const wizardStateEntries: Record<string, unknown> = {};
			if (input.currentStep !== undefined) {
				wizardStateEntries.currentStep = input.currentStep;
			}
			if (input.customRequirements !== undefined) {
				wizardStateEntries.customRequirements =
					input.customRequirements;
			}
			if (input.documents !== undefined) {
				wizardStateEntries.documents = input.documents;
			}
			if (input.tempContextIds !== undefined) {
				wizardStateEntries.tempContextIds = input.tempContextIds;
			}
			if (input.wizardSessionId !== undefined) {
				wizardStateEntries.wizardSessionId = input.wizardSessionId;
			}
			if (input.selectedTeamsChats !== undefined) {
				wizardStateEntries.selectedTeamsChats =
					input.selectedTeamsChats;
			}
			if (input.selectedNotionPages !== undefined) {
				wizardStateEntries.selectedNotionPages =
					input.selectedNotionPages;
			}
			if (input.selectedSlackChannels !== undefined) {
				wizardStateEntries.selectedSlackChannels =
					input.selectedSlackChannels;
			}
			if (input.selectedGitHubRepos !== undefined) {
				wizardStateEntries.selectedGitHubRepos =
					input.selectedGitHubRepos;
			}
			if (input.selectedGitLabRepos !== undefined) {
				wizardStateEntries.selectedGitLabRepos =
					input.selectedGitLabRepos;
			}
			// ADO repo metadata only (no PAT — see input schema note above).
			if (input.selectedAzureDevOpsRepos !== undefined) {
				wizardStateEntries.selectedAzureDevOpsRepos =
					input.selectedAzureDevOpsRepos;
			}
			if (input.codebaseRepoUrls !== undefined) {
				wizardStateEntries.codebaseRepoUrls = input.codebaseRepoUrls;
			}
			if (input.primaryWebsiteUrl !== undefined) {
				wizardStateEntries.primaryWebsiteUrl = input.primaryWebsiteUrl;
			}
			if (input.additionalWebsiteUrls !== undefined) {
				wizardStateEntries.additionalWebsiteUrls =
					input.additionalWebsiteUrls;
			}
			if (input.projectManagementDetectedType !== undefined) {
				wizardStateEntries.projectManagementDetectedType =
					input.projectManagementDetectedType;
			}
			if (input.documentPrompts !== undefined) {
				wizardStateEntries.documentPrompts = input.documentPrompts;
			}

			// undefined → "client didn't send any wizard-only fields on this save,
			// preserve existing wizardState"; defined → "overwrite blob with this snapshot".
			const wizardState =
				Object.keys(wizardStateEntries).length > 0
					? (wizardStateEntries as Prisma.InputJsonValue)
					: undefined;

			const projectManagementAdditionalContext =
				input.projectManagementAdditionalContext === undefined
					? undefined
					: (input.projectManagementAdditionalContext as Prisma.InputJsonValue);

			const { project, created } = await upsertDraftProjectByKey({
				draftKey: input.draftKey,
				name: input.name.trim(),
				userId: context.user.id,
				organizationId,
				description: input.description,
				techStack: input.techStack,
				features: input.features,
				projectTypes: input.projectTypes,
				tags: input.tags,
				icon: input.icon,
				color: input.color,
				goals: input.goals,
				wizardState,
				repositoryUrl: input.repositoryUrl,
				repositoryOwner: input.repositoryOwner,
				repositoryName: input.repositoryName,
				defaultBranch: input.defaultBranch,
				projectManagementMcpServerId:
					input.projectManagementMcpServerId,
				projectManagementMcpConfigId:
					input.projectManagementMcpConfigId,
				projectManagementContainerId:
					input.projectManagementContainerId,
				projectManagementContainerName:
					input.projectManagementContainerName,
				projectManagementAdditionalContext,
			});

			return {
				project: {
					id: project.id,
					name: project.name,
					draftKey: project.draftKey,
					wizardState: project.wizardState,
				},
				created,
			};
		} catch (error) {
			console.error("[SaveDraft] Error:", {
				error,
				errorMessage:
					error instanceof Error ? error.message : String(error),
				userId: context.user.id,
				draftKey: input.draftKey,
			});
			if (error instanceof ORPCError) {
				throw error;
			}
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to save draft project",
			});
		}
	});
