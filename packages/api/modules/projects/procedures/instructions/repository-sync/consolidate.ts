/**
 * Move a code repository's AI files into a separate instructions repository
 * that Fabric creates (specs/2026-10-21-ai-artifacts-hub §5.2, P4).
 *
 * - `previewConsolidation` lists the code repository's default branch and
 *   returns the plan: each AI file and where it goes in the canonical layout.
 * - `startConsolidation` creates the GitHub repository with the person's
 *   GitHub token (a PAT typed into the dialog, or their GitHub workflow
 *   integration's PAT), connects it to the project with that PAT, records the
 *   run and starts `instructionConsolidationWorkflow`, which copies the files,
 *   points Coding Instructions at the new repository and opens a pull request
 *   removing the files from the code repository.
 * - `getConsolidation` is the newest run's state for the tab.
 *
 * The token never enters the workflow: the repository is created and
 * connected here, and the workflow resolves the stored credential itself.
 *
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible +
 * INSTRUCTION_CREATE (as `configure`); starting also needs
 * PROJECT_SETTINGS_EDIT, because it connects a repository to the project
 * (as `repositoryIntegrations.connect`).
 */
import { ORPCError } from "@orpc/client";
import { config } from "@repo/config";
import {
	createGitHubRepository,
	GITHUB_REPOSITORY_NAME_PATTERN,
	isRepositoryTreeProvider,
	listRepositoryTree,
} from "@repo/connectors";
import {
	createInstructionConsolidation,
	createProjectRepoIntegration,
	db,
	getLatestInstructionConsolidation,
	getRunningInstructionConsolidation,
	updateInstructionConsolidation,
} from "@repo/database";
import {
	type ConsolidationItem,
	planConsolidation,
	renderDirectCommitText,
} from "@repo/instructions";
import { getGitHubWorkflowCredential } from "@repo/integrations/github";
import { getTemporalClient } from "@repo/temporal";
import { startInstructionConsolidationWorkflow } from "@repo/temporal/instruction-consolidation-start";
import { decryptApiKey, encryptApiKey } from "@repo/utils";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../../lib/audit";
import { withCorrelationMemo } from "../../../../../lib/temporal-correlation";
import { projectNotFoundUnlessVisible } from "../../../../../orpc/middleware/project-visibility";
import {
	assertProjectPermission,
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { requireHostingOrganizationId } from "../hosting-organization";
import { assertNoOpenMigration } from "../migration-freeze";
import {
	loadInstructionSyncIntegration,
	repositoryReadError,
	resolveInstructionSyncCredential,
} from "./repository";

const projectInput = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
});

/** The code repository's AI files, planned from its default branch's tree. */
async function planFor(input: {
	projectId: string;
	repositoryIntegrationId: string;
	userId: string;
	organizationId: string;
}) {
	const integration = await loadInstructionSyncIntegration({
		repositoryIntegrationId: input.repositoryIntegrationId,
		projectId: input.projectId,
	});
	if (!isRepositoryTreeProvider(integration.provider)) {
		throw new ORPCError("BAD_REQUEST", {
			message:
				"Moving AI files out is available for GitHub and Azure DevOps repositories.",
			data: { code: "PROVIDER_UNSUPPORTED" },
		});
	}
	const { token, refreshFault } = await resolveInstructionSyncCredential(
		integration,
		{ userId: input.userId, organizationId: input.organizationId },
	);
	const tree = await listRepositoryTree({
		provider: integration.provider,
		token,
		repositoryUrl: integration.repositoryUrl,
		owner: integration.repositoryOwner,
		repo: integration.repositoryName,
		azureOrganization: integration.azureOrganization,
		...(integration.provider === "AZURE_DEVOPS" &&
		integration.authMethod !== "PAT"
			? { azureDevOpsAuth: "bearer" as const }
			: {}),
		branch: integration.defaultBranch,
	});
	if (!tree.ok) {
		throw repositoryReadError(
			tree.outcome === "unsupported" ? "unreachable" : tree.outcome,
			{
				ref: integration.defaultBranch,
				refreshFault,
				unreachableMessage:
					"Couldn't reach the repository to list its files. Try again.",
			},
		);
	}
	const plan = planConsolidation(
		tree.entries
			.filter((entry) => entry.type === "file")
			.map((entry) => ({
				path: entry.path,
				...(entry.blobId ? { oid: entry.blobId } : {}),
				...(entry.mode ? { mode: entry.mode } : {}),
			})),
	);
	return { integration, plan, truncated: tree.truncated };
}

/**
 * The user's GitHub sign-in as a repository connection's credential, the way
 * `existingSetup.start` connects repositories with it: the (just refreshed)
 * access token, its refresh token and expiry, re-encrypted for the row.
 */
async function signedInCredential(userId: string, organizationId: string) {
	const row = await db.workflowIntegration.findFirst({
		where: {
			userId,
			organizationId,
			provider: "GITHUB",
			NOT: { name: "GITHUB_OAUTH_APP" },
			isActive: true,
		},
		select: { credentials: true },
	});
	const json = row?.credentials
		? (JSON.parse(decryptApiKey(row.credentials)) as {
				access_token?: string;
				refresh_token?: string;
				expires_in?: number;
				token_obtained_at?: string;
				scope?: string;
			})
		: {};
	if (!json.access_token) {
		throw new ORPCError("BAD_REQUEST", {
			message: "Sign in with GitHub again and retry.",
			data: { code: "TOKEN_REQUIRED" },
		});
	}
	return {
		authMethod: "OAUTH" as const,
		encryptedAccessToken: encryptApiKey(json.access_token),
		encryptedRefreshToken: json.refresh_token
			? encryptApiKey(json.refresh_token)
			: undefined,
		tokenExpiresAt: json.expires_in
			? new Date(
					(json.token_obtained_at
						? new Date(json.token_obtained_at).getTime()
						: Date.now()) +
						json.expires_in * 1000,
				)
			: undefined,
		tokenScopes: json.scope ? json.scope.split(",") : [],
	};
}

function runView(
	run: Awaited<ReturnType<typeof getLatestInstructionConsolidation>>,
) {
	if (!run) {
		return null;
	}
	return {
		id: run.id,
		status: run.status,
		step: run.step,
		fileCount: run.fileCount,
		targetRepositoryUrl: run.targetRepositoryUrl,
		cleanupPullRequestUrl: run.cleanupPullRequestUrl,
		error: run.error,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
	};
}

export const getConsolidationProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/instructions/consolidation",
		tags: ["Projects", "Instructions"],
		summary: "The newest move of AI files into an instructions repository",
	})
	.input(projectInput)
	.handler(async ({ input }) => ({
		run: runView(await getLatestInstructionConsolidation(input.projectId)),
	}));

export const previewConsolidationProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_CREATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/instructions/consolidation/preview",
		tags: ["Projects", "Instructions"],
		summary: "Plan moving a code repository's AI files out",
	})
	.input(projectInput.extend({ repositoryIntegrationId: z.string().min(1) }))
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const { integration, plan, truncated } = await planFor({
			projectId: input.projectId,
			repositoryIntegrationId: input.repositoryIntegrationId,
			userId: context.user.id,
			organizationId,
		});
		const credential = await getGitHubWorkflowCredential(
			context.user.id,
			organizationId,
		);
		return {
			repository: {
				owner: integration.repositoryOwner,
				name: integration.repositoryName,
				defaultBranch: integration.defaultBranch,
			},
			items: plan.items,
			skipped: plan.skipped,
			truncated,
			suggested: {
				owner: integration.repositoryOwner,
				name: `${integration.repositoryName}-ai-instructions`.slice(
					0,
					100,
				),
			},
			/** A stored GitHub PAT can create the repository; otherwise the dialog asks for one. */
			// A saved PAT or GitHub sign-in is tried first; the dialog asks
			// for a token only when GitHub refuses it.
			storedTokenAvailable: credential !== null,
		};
	});

const CREATE_REFUSALS: Record<string, string> = {
	exists: "A repository with that name already exists. Choose another name.",
	forbidden:
		"The GitHub token may not create repositories there. Use a token with the 'repo' scope (classic) or 'Administration: write' (fine-grained), and check the organization allows it.",
	unauthorized: "GitHub rejected the token. Check it and try again.",
	invalid:
		"GitHub refused the repository name. Use letters, digits, '.', '-' or '_'.",
	unreachable: "Couldn't reach GitHub to create the repository. Try again.",
};

export const startConsolidationProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_CREATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/instructions/consolidation",
		tags: ["Projects", "Instructions"],
		summary:
			"Create an instructions repository and move the code repository's AI files there",
	})
	.input(
		projectInput.extend({
			repositoryIntegrationId: z.string().min(1),
			repository: z.object({
				/** An organization login, or null for the token's own account. */
				owner: z.string().min(1).max(100).nullable(),
				name: z.string().regex(GITHUB_REPOSITORY_NAME_PATTERN),
				private: z.boolean().default(true),
			}),
			/** A GitHub PAT; omitted when the person's stored GitHub PAT should be used. */
			token: z.string().min(1).max(500).optional(),
			/** The `from` paths the person confirmed. */
			include: z.array(z.string().min(1).max(1024)).min(1).max(5000),
		}),
	)
	.handler(async ({ input, context }) => {
		await assertProjectPermission(
			input.projectId,
			context.user.id,
			Permissions.PROJECT_SETTINGS_EDIT,
		);
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		await assertNoOpenMigration({
			projectId: input.projectId,
			organizationId,
		});
		if (await getRunningInstructionConsolidation(input.projectId)) {
			throw new ORPCError("CONFLICT", {
				message: "AI files are already being moved for this project.",
				data: { code: "CONSOLIDATION_RUNNING" },
			});
		}

		// Re-planned from the live tree: the preview is advisory.
		const { integration, plan } = await planFor({
			projectId: input.projectId,
			repositoryIntegrationId: input.repositoryIntegrationId,
			userId: context.user.id,
			organizationId,
		});
		const include = new Set(input.include);
		const chosen: ConsolidationItem[] = plan.items.filter((item) =>
			include.has(item.from),
		);
		if (!chosen.some((item) => item.to !== null)) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"None of the selected files are AI files on the default branch any more. Refresh the list.",
				data: { code: "NOTHING_SELECTED" },
			});
		}

		const rendered = renderDirectCommitText({
			message: "Move AI instructions",
			proposerName: context.user.name ?? "",
			mailFrom: config.mails.from,
		});
		if (!rendered.ok) {
			throw new ORPCError("PRECONDITION_FAILED", {
				message:
					"Fabric's commit identity is not configured, so it cannot write commits.",
				data: { code: "ATTRIBUTION_UNAVAILABLE" },
			});
		}

		let token = input.token?.trim() ?? "";
		let signedIn = false;
		if (token === "") {
			const stored = await getGitHubWorkflowCredential(
				context.user.id,
				organizationId,
			);
			if (!stored) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"Sign in with GitHub or add a personal access token that may create repositories.",
					data: { code: "TOKEN_REQUIRED" },
				});
			}
			token = stored.token;
			signedIn = stored.kind === "oauth";
		}
		const created = await createGitHubRepository({
			token,
			owner: input.repository.owner,
			name: input.repository.name,
			private: input.repository.private,
			description: `AI instructions for ${integration.repositoryOwner}/${integration.repositoryName}, managed by Fabric`,
		});
		if (!created.ok && signedIn && created.outcome === "forbidden") {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Your GitHub sign-in may not create repositories (the Fabric GitHub App has no Administration permission there). Paste a personal access token that may create them.",
				data: { code: "TOKEN_REQUIRED" },
			});
		}
		if (!created.ok) {
			throw new ORPCError(
				created.outcome === "exists" ? "CONFLICT" : "BAD_REQUEST",
				{
					message: CREATE_REFUSALS[created.outcome],
					data: {
						code: `REPOSITORY_${created.outcome.toUpperCase()}`,
					},
				},
			);
		}
		const repository = created.repository;
		const target = await createProjectRepoIntegration({
			projectId: input.projectId,
			provider: "GITHUB",
			repositoryUrl: repository.url,
			repositoryOwner: repository.owner,
			repositoryName: repository.name,
			defaultBranch: repository.defaultBranch,
			roleTag: "AI instructions",
			...(signedIn
				? await signedInCredential(context.user.id, organizationId)
				: {
						authMethod: "PAT" as const,
						encryptedPat: encryptApiKey(token),
					}),
			configuredByUserId: context.user.id,
		});
		const run = await createInstructionConsolidation({
			projectId: input.projectId,
			userId: context.user.id,
			organizationId,
			sourceIntegrationId: integration.id,
			targetIntegrationId: target.id,
			targetRepositoryUrl: repository.url,
			files: chosen.map((item) => ({
				from: item.from,
				to: item.to,
				...(item.transform ? { transform: item.transform } : {}),
			})),
		});
		try {
			const client = await getTemporalClient();
			await startInstructionConsolidationWorkflow(
				client,
				{
					consolidationId: run.id,
					projectId: input.projectId,
					organizationId,
					userId: context.user.id,
					author: rendered.author,
					committer: rendered.committer,
				},
				{ decorateStartOptions: withCorrelationMemo },
			);
		} catch (error) {
			await updateInstructionConsolidation(run.id, input.projectId, {
				status: "FAILED",
				error: "The move could not be started. Try again.",
			});
			throw error;
		}

		recordAuditFromRequest(context, {
			action: "project.instructions.consolidation_started",
			category: "project",
			organizationId,
			projectId: input.projectId,
			resource: {
				type: "project_repository_integration",
				id: target.id,
				name: `${repository.owner}/${repository.name}`,
			},
			metadata: {
				sourceRepository: `${integration.repositoryOwner}/${integration.repositoryName}`,
				fileCount: chosen.length,
				private: input.repository.private,
			},
		});
		return {
			run: runView(run),
			repository,
		};
	});

/**
 * Runs a failed move again on the repository it already created and
 * connected: every step is idempotent, so a retry continues where the run
 * stopped. Same gates as `startConsolidation`.
 */
export const retryConsolidationProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_CREATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/instructions/consolidation/retry",
		tags: ["Projects", "Instructions"],
		summary:
			"Retry a failed move of AI files into the instructions repository",
	})
	.input(projectInput)
	.handler(async ({ input, context }) => {
		await assertProjectPermission(
			input.projectId,
			context.user.id,
			Permissions.PROJECT_SETTINGS_EDIT,
		);
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const run = await getLatestInstructionConsolidation(input.projectId);
		if (!run || run.status !== "FAILED" || !run.targetIntegrationId) {
			throw new ORPCError("CONFLICT", {
				message: "There is no failed move to retry.",
				data: { code: "NOTHING_TO_RETRY" },
			});
		}
		const rendered = renderDirectCommitText({
			message: "Move AI instructions",
			proposerName: context.user.name ?? "",
			mailFrom: config.mails.from,
		});
		if (!rendered.ok) {
			throw new ORPCError("PRECONDITION_FAILED", {
				message:
					"Fabric's commit identity is not configured, so it cannot write commits.",
				data: { code: "ATTRIBUTION_UNAVAILABLE" },
			});
		}
		await updateInstructionConsolidation(run.id, input.projectId, {
			status: "RUNNING",
			error: null,
		});
		try {
			const client = await getTemporalClient();
			await startInstructionConsolidationWorkflow(
				client,
				{
					consolidationId: run.id,
					projectId: input.projectId,
					organizationId,
					userId: context.user.id,
					author: rendered.author,
					committer: rendered.committer,
				},
				{ decorateStartOptions: withCorrelationMemo },
			);
		} catch (error) {
			await updateInstructionConsolidation(run.id, input.projectId, {
				status: "FAILED",
				error: "The move could not be started. Try again.",
			});
			throw error;
		}
		return {
			run: runView(
				await getLatestInstructionConsolidation(input.projectId),
			),
		};
	});
