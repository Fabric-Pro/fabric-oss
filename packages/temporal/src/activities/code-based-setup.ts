/**
 * Code-Based Project Setup Activities
 *
 * Activities for the codeBasedProjectSetupWorkflow:
 * 1. findGitHubMcpConfig — Locate user's GitHub MCP config
 * 1b. findAzureDevOpsMcpConfig — Locate user's Azure DevOps MCP config
 * 1b2. findGitLabMcpConfig — Locate user's GitLab MCP config
 * 1b3. findGitLabOAuthConfig — Locate user's GitLab OAuth integration (for code-based setup)
 * 2. updateProjectCodeAnalysisStatus — Update project scanning status
 * 3. saveCodeAnalysisContext — Store orchestrator response as project context
 * 4. createCodeBasedDocumentRecords — Create 4 document records for code-based setup
 */

import {
	type CodeAnalysisStatus,
	db,
	findProjectRepoCredentials,
	getMcpConfigForTenantAndServer,
	getMcpServerByKey,
	type ProjectDocumentType,
} from "@repo/database";

// ============================================================================
// 1. findGitHubMcpConfig
// ============================================================================

export interface FindGitHubMcpConfigInput {
	userId: string;
	organizationId?: string;
}

export interface FindGitHubMcpConfigOutput {
	mcpConfigId: string;
	mcpServerId: string;
}

/**
 * Find the user's GitHub MCP configuration.
 *
 * Supports two setups:
 * 1. Seeded STDIO server (key="github") with user config pointing to it
 * 2. User-created HTTP server (e.g., github copilot MCP) with "github" in its name
 *
 * Tries the seeded server first, then falls back to name-based search.
 */
export async function findGitHubMcpConfig(
	input: FindGitHubMcpConfigInput,
): Promise<FindGitHubMcpConfigOutput> {
	const { userId, organizationId } = input;

	// Strategy 1: Try the seeded "github" server key (STDIO path)
	const githubServer = await getMcpServerByKey("github", {
		userId,
		organizationId,
		includeSystem: true,
	});

	if (githubServer) {
		const config = await getMcpConfigForTenantAndServer({
			mcpServerId: githubServer.id,
			userId,
			organizationId,
		});

		if (config?.enabled) {
			return {
				mcpConfigId: config.id,
				mcpServerId: githubServer.id,
			};
		}
	}

	// Strategy 2: Search for any enabled MCP config with "github" in its name (HTTP path)
	// This handles user-created GitHub HTTP servers (e.g., GitHub Copilot MCP)
	const tenantFilter = organizationId
		? { userId, organizationId }
		: { userId, organizationId: null };

	const githubConfig = await db.mCPConfig.findFirst({
		where: {
			...tenantFilter,
			enabled: true,
			OR: [
				{
					displayName: {
						contains: "github",
						mode: "insensitive" as const,
					},
				},
				{
					mcpServer: {
						name: {
							contains: "github",
							mode: "insensitive" as const,
						},
					},
				},
				{
					mcpServer: {
						key: {
							contains: "github",
							mode: "insensitive" as const,
						},
					},
				},
			],
		},
		include: { mcpServer: true },
		orderBy: { updatedAt: "desc" },
	});

	if (githubConfig) {
		return {
			mcpConfigId: githubConfig.id,
			mcpServerId: githubConfig.mcpServerId,
		};
	}

	throw new Error(
		"GitHub MCP is not configured. Please set up GitHub in Settings → MCP Servers.",
	);
}

// ============================================================================
// 1b. findAzureDevOpsMcpConfig
// ============================================================================

export interface FindAzureDevOpsMcpConfigInput {
	userId: string;
	organizationId?: string;
}

export interface FindAzureDevOpsMcpConfigOutput {
	mcpConfigId: string;
	mcpServerId: string;
}

/**
 * Find the user's Azure DevOps MCP configuration.
 *
 * Supports two setups:
 * 1. Seeded server (key="azure-devops") with user config pointing to it
 * 2. User-created server with "azure" or "devops" in its name
 */
export async function findAzureDevOpsMcpConfig(
	input: FindAzureDevOpsMcpConfigInput,
): Promise<FindAzureDevOpsMcpConfigOutput> {
	const { userId, organizationId } = input;

	// Strategy 1: Try the seeded "azure-devops" server key
	const adoServer = await getMcpServerByKey("azure-devops", {
		userId,
		organizationId,
		includeSystem: true,
	});

	if (adoServer) {
		const config = await getMcpConfigForTenantAndServer({
			mcpServerId: adoServer.id,
			userId,
			organizationId,
		});

		if (config?.enabled) {
			return {
				mcpConfigId: config.id,
				mcpServerId: adoServer.id,
			};
		}
	}

	// Strategy 2: Search for any enabled MCP config with "azure" or "devops" in its name
	const tenantFilter = organizationId
		? { userId, organizationId }
		: { userId, organizationId: null };

	const adoConfig = await db.mCPConfig.findFirst({
		where: {
			...tenantFilter,
			enabled: true,
			OR: [
				{
					displayName: {
						contains: "azure",
						mode: "insensitive" as const,
					},
				},
				{
					displayName: {
						contains: "devops",
						mode: "insensitive" as const,
					},
				},
				{
					mcpServer: {
						name: {
							contains: "azure",
							mode: "insensitive" as const,
						},
					},
				},
				{
					mcpServer: {
						key: {
							contains: "azure-devops",
							mode: "insensitive" as const,
						},
					},
				},
			],
		},
		include: { mcpServer: true },
		orderBy: { updatedAt: "desc" },
	});

	if (adoConfig) {
		return {
			mcpConfigId: adoConfig.id,
			mcpServerId: adoConfig.mcpServerId,
		};
	}

	throw new Error(
		"Azure DevOps MCP is not configured. Please set up Azure DevOps in Settings → MCP Servers.",
	);
}

// ============================================================================
// 1b2. findGitLabMcpConfig
// ============================================================================

export interface FindGitLabMcpConfigInput {
	userId: string;
	organizationId?: string;
}

export interface FindGitLabMcpConfigOutput {
	mcpConfigId: string;
	mcpServerId: string;
}

/**
 * Find the user's GitLab MCP configuration.
 *
 * Supports two setups:
 * 1. Seeded server (key="gitlab") with user config pointing to it
 * 2. User-created server with "gitlab" in its name
 */
export async function findGitLabMcpConfig(
	input: FindGitLabMcpConfigInput,
): Promise<FindGitLabMcpConfigOutput> {
	const { userId, organizationId } = input;

	// Strategy 1: Try the seeded "gitlab" server key
	const gitlabServer = await getMcpServerByKey("gitlab", {
		userId,
		organizationId,
		includeSystem: true,
	});

	if (gitlabServer) {
		const config = await getMcpConfigForTenantAndServer({
			mcpServerId: gitlabServer.id,
			userId,
			organizationId,
		});

		if (config?.enabled) {
			return {
				mcpConfigId: config.id,
				mcpServerId: gitlabServer.id,
			};
		}
	}

	// Strategy 2: Search for any enabled MCP config with "gitlab" in its name
	const tenantFilter = organizationId
		? { userId, organizationId }
		: { userId, organizationId: null };

	const gitlabConfig = await db.mCPConfig.findFirst({
		where: {
			...tenantFilter,
			enabled: true,
			OR: [
				{
					displayName: {
						contains: "gitlab",
						mode: "insensitive" as const,
					},
				},
				{
					mcpServer: {
						name: {
							contains: "gitlab",
							mode: "insensitive" as const,
						},
					},
				},
				{
					mcpServer: {
						key: {
							contains: "gitlab",
							mode: "insensitive" as const,
						},
					},
				},
			],
		},
		include: { mcpServer: true },
		orderBy: { updatedAt: "desc" },
	});

	if (gitlabConfig) {
		return {
			mcpConfigId: gitlabConfig.id,
			mcpServerId: gitlabConfig.mcpServerId,
		};
	}

	throw new Error(
		"GitLab MCP is not configured. Please set up GitLab in Settings → MCP Servers.",
	);
}

// ============================================================================
// 1b3. findGitLabOAuthConfig
// ============================================================================

export interface FindGitLabOAuthConfigInput {
	userId: string;
	organizationId?: string;
}

export interface FindGitLabOAuthConfigOutput {
	/** Synthetic config ID recognized by loadOAuthIntegrationTools() */
	oauthConfigId: string;
	integrationId: string;
}

/**
 * Find the user's GitLab OAuth WorkflowIntegration and return a synthetic
 * config ID that the orchestrator's loadOAuthIntegrationTools() understands.
 *
 * GitLab tools are loaded via OAuth integration, not MCP server.
 * The synthetic ID format `oauth-gitlab:{integrationId}` matches the
 * pattern used in findMcpConfigsForRepos().
 */
export async function findGitLabOAuthConfig(
	input: FindGitLabOAuthConfigInput,
): Promise<FindGitLabOAuthConfigOutput> {
	const { userId, organizationId } = input;

	const tenantFilter = organizationId
		? { userId, organizationId }
		: { userId, organizationId: null };

	const integration = await db.workflowIntegration.findFirst({
		where: {
			...tenantFilter,
			provider: "GITLAB",
			isActive: true,
		},
		select: { id: true },
	});

	if (!integration) {
		throw new Error(
			"GitLab is not connected. Please connect GitLab in Settings → Integrations.",
		);
	}

	return {
		oauthConfigId: `oauth-gitlab:${integration.id}`,
		integrationId: integration.id,
	};
}

// ============================================================================
// 1c. findMcpConfigsForRepos
// ============================================================================

export interface FindMcpConfigsForReposInput {
	repoUrls: string[];
	userId: string;
	organizationId?: string;
	/** When provided, checks ProjectRepositoryIntegration before user-level MCP configs */
	projectId?: string;
}

export interface RepoMcpMapping {
	repoUrl: string;
	mcpConfigId: string;
	provider: "github" | "gitlab" | "azure-devops";
	/** When credentials come from a project-level integration */
	projectIntegrationId?: string;
}

export interface FindMcpConfigsForReposOutput {
	mappings: RepoMcpMapping[];
	/** All unique MCP config IDs found */
	allMcpConfigIds: string[];
	/** Whether any repo used project-level credentials */
	usedProjectCredentials: boolean;
}

/**
 * Given an array of repo URLs, detect which are GitHub vs Azure DevOps
 * and find credentials for each.
 *
 * Priority: project-level integration → user-level MCP config.
 */
export async function findMcpConfigsForRepos(
	input: FindMcpConfigsForReposInput,
): Promise<FindMcpConfigsForReposOutput> {
	const { repoUrls, userId, organizationId, projectId } = input;
	const mappings: RepoMcpMapping[] = [];
	const configIdSet = new Set<string>();
	let usedProjectCredentials = false;

	// Detect providers from URLs
	let githubConfigId: string | undefined;
	let gitlabConfigId: string | undefined;
	let adoConfigId: string | undefined;

	for (const url of repoUrls) {
		const trimmed = url.trim();
		if (!trimmed) {
			continue;
		}

		const isGitHub =
			/github\.com/i.test(trimmed) ||
			/githubusercontent\.com/i.test(trimmed);
		const isGitLab = /gitlab\.com/i.test(trimmed);
		const isAdo =
			/dev\.azure\.com/i.test(trimmed) ||
			/visualstudio\.com/i.test(trimmed);

		// Step 1: Check project-level integration first
		if (projectId) {
			const projectCred = await findProjectRepoCredentials(
				trimmed,
				projectId,
			);
			if (projectCred.source === "project") {
				usedProjectCredentials = true;

				// Project credentials provide the AUTH TOKEN, but the orchestrator
				// still needs an MCP config for TOOL DEFINITIONS (list_repositories,
				// get_file_contents, etc.). Find the MCP config for tool loading
				// and add it to configIdSet so the orchestrator can discover tools.
				let toolMcpConfigId: string | undefined;
				if (isGitHub && !githubConfigId) {
					try {
						const result = await findGitHubMcpConfig({
							userId,
							organizationId,
						});
						githubConfigId = result.mcpConfigId;
						toolMcpConfigId = githubConfigId;
					} catch {
						// No GitHub MCP config — orchestrator won't have GitHub tools
					}
				} else if (isGitHub && githubConfigId) {
					toolMcpConfigId = githubConfigId;
				}
				// GitLab tools come from OAuth integration, not MCP server.
				// Use a synthetic config ID — the orchestrator loads GitLab tools
				// via loadOAuthIntegrationTools() when WorkflowIntegration exists.
				if (isGitLab && !gitlabConfigId) {
					const hasGitLabOAuth =
						await db.workflowIntegration.findFirst({
							where: {
								userId,
								provider: "GITLAB",
								isActive: true,
								...(organizationId
									? { organizationId }
									: { organizationId: null }),
							},
							select: { id: true },
						});
					if (hasGitLabOAuth) {
						gitlabConfigId = `oauth-gitlab:${hasGitLabOAuth.id}`;
						toolMcpConfigId = gitlabConfigId;
					}
				} else if (isGitLab && gitlabConfigId) {
					toolMcpConfigId = gitlabConfigId;
				}
				if (isAdo && !adoConfigId) {
					try {
						const result = await findAzureDevOpsMcpConfig({
							userId,
							organizationId,
						});
						adoConfigId = result.mcpConfigId;
						toolMcpConfigId = adoConfigId;
					} catch {
						// No ADO MCP config
					}
				} else if (isAdo && adoConfigId) {
					toolMcpConfigId = adoConfigId;
				}

				if (toolMcpConfigId) {
					configIdSet.add(toolMcpConfigId);
				}

				mappings.push({
					repoUrl: trimmed,
					mcpConfigId:
						toolMcpConfigId ??
						`project-repo:${projectCred.integrationId}`,
					provider: isGitHub
						? "github"
						: isGitLab
							? "gitlab"
							: "azure-devops",
					projectIntegrationId: projectCred.integrationId,
				});
				continue;
			}
		}

		// Step 2: Fall back to user-level MCP config
		if (isGitHub) {
			if (!githubConfigId) {
				try {
					const result = await findGitHubMcpConfig({
						userId,
						organizationId,
					});
					githubConfigId = result.mcpConfigId;
				} catch {
					// GitHub MCP not configured — skip these repos
					continue;
				}
			}
			mappings.push({
				repoUrl: trimmed,
				mcpConfigId: githubConfigId,
				provider: "github",
			});
			configIdSet.add(githubConfigId);
		} else if (isGitLab) {
			// GitLab tools come from OAuth integration, not MCP server.
			// Check for WorkflowIntegration directly.
			if (!gitlabConfigId) {
				const hasGitLabOAuth = await db.workflowIntegration.findFirst({
					where: {
						userId,
						provider: "GITLAB",
						isActive: true,
						...(organizationId
							? { organizationId }
							: { organizationId: null }),
					},
					select: { id: true },
				});
				if (!hasGitLabOAuth) {
					// GitLab OAuth not connected — skip these repos
					continue;
				}
				gitlabConfigId = `oauth-gitlab:${hasGitLabOAuth.id}`;
			}
			mappings.push({
				repoUrl: trimmed,
				mcpConfigId: gitlabConfigId,
				provider: "gitlab",
			});
			// Don't add synthetic ID to configIdSet — it's not a real MCP config.
			// The orchestrator loads GitLab tools via loadOAuthIntegrationTools().
		} else if (isAdo) {
			if (!adoConfigId) {
				try {
					const result = await findAzureDevOpsMcpConfig({
						userId,
						organizationId,
					});
					adoConfigId = result.mcpConfigId;
				} catch {
					// ADO MCP not configured — skip these repos for the
					// orchestrator's Phase-1 "code analysis" doc-gen. This is
					// BEST-EFFORT for Azure DevOps and intentionally never hard-
					// fails: clone-based AST indexing (`codeIndexingWorkflow`,
					// PAT-only, gated by FEATURE_CODE_INDEXING) is the SOURCE OF
					// TRUTH for ADO code context and runs independently off the
					// `ProjectRepositoryIntegration` / legacy-URL sync. Do NOT
					// reintroduce a hard ADO-MCP dependency here.
					continue;
				}
			}
			mappings.push({
				repoUrl: trimmed,
				mcpConfigId: adoConfigId,
				provider: "azure-devops",
			});
			configIdSet.add(adoConfigId);
		}
		// Unknown provider — skip
	}

	return {
		mappings,
		allMcpConfigIds: [...configIdSet],
		usedProjectCredentials,
	};
}

// ============================================================================
// 2. updateProjectCodeAnalysisStatus
// ============================================================================

export interface UpdateProjectCodeAnalysisStatusInput {
	projectId: string;
	status: CodeAnalysisStatus;
	workflowId?: string;
}

/**
 * Update the codeAnalysisStatus field on the Project.
 */
export async function updateProjectCodeAnalysisStatus(
	input: UpdateProjectCodeAnalysisStatusInput,
): Promise<void> {
	const { projectId, status, workflowId } = input;

	await db.project.update({
		where: { id: projectId },
		data: {
			codeAnalysisStatus: status,
			...(workflowId ? { codeAnalysisWorkflowId: workflowId } : {}),
		},
	});
}

// ============================================================================
// 3. saveCodeAnalysisContext
// ============================================================================

export interface SaveCodeAnalysisContextInput {
	projectId: string;
	userId: string;
	organizationId?: string;
	analysisContent: string;
	repositoryOwner: string;
	repositoryName: string;
	/** Original repo URL(s) — used for sourceUrl instead of hardcoding GitHub */
	repoUrls?: string[];
}

export interface SaveCodeAnalysisContextOutput {
	contextId: string;
}

/**
 * Save the orchestrator's code analysis response as an INTEGRATION context on the project.
 * This makes it available for future RAG queries and regeneration.
 */
const PROVIDER_BY_SOURCE = {
	"azure-devops": "AZURE_DEVOPS",
	gitlab: "GITLAB",
	github: "GITHUB",
} as const;

export async function saveCodeAnalysisContext(
	input: SaveCodeAnalysisContextInput,
): Promise<SaveCodeAnalysisContextOutput> {
	const {
		projectId,
		userId,
		organizationId,
		analysisContent,
		repositoryOwner,
		repositoryName,
		repoUrls,
	} = input;

	// Derive sourceUrl from the actual repo URLs, not hardcoded GitHub
	const sourceUrl =
		repoUrls && repoUrls.length > 0
			? repoUrls[0]
			: `https://github.com/${repositoryOwner}/${repositoryName}`;

	// Detect source provider from URL
	const source = repoUrls?.some((u) =>
		/dev\.azure\.com|visualstudio\.com/i.test(u),
	)
		? "azure-devops"
		: repoUrls?.some((u) => /gitlab\.com/i.test(u))
			? "gitlab"
			: "github";

	const providerEnum = PROVIDER_BY_SOURCE[source];

	// Resolve active repository integration ID to populate durable join key on saved context.
	const repoIntegration = await db.projectRepositoryIntegration.findFirst({
		where: {
			projectId,
			provider: providerEnum,
			repositoryOwner,
			repositoryName,
			status: "ACTIVE",
		},
		select: { id: true },
	});

	const context = await db.projectContext.create({
		data: {
			projectId,
			type: "TEXT",
			content: analysisContent,
			sourceTitle: `Code Analysis: ${repositoryOwner}/${repositoryName}`,
			sourceUrl,
			metadata: {
				provider: "CODE_ANALYSIS",
				source,
				repo: `${repositoryOwner}/${repositoryName}`,
				repositoryIntegrationId: repoIntegration?.id ?? null,
				analyzedAt: new Date().toISOString(),
			},
			extractionStatus: "COMPLETED",
			userId,
			organizationId: organizationId ?? null,
		},
	});

	return { contextId: context.id };
}

// ============================================================================
// 4. createCodeBasedDocumentRecords
// ============================================================================

/** The 4 document types generated from code analysis */
const CODE_BASED_DOCUMENTS: Array<{
	type: ProjectDocumentType;
	title: string;
}> = [
	{ type: "PRD", title: "Product Requirements Document" },
	{ type: "ARCHITECTURE", title: "Technical Architecture" },
	{ type: "TECHNICAL_SPEC", title: "Technical Specification" },
	{ type: "API_SPEC", title: "API Specification" },
];

export interface CreateCodeBasedDocumentRecordsInput {
	projectId: string;
	userId: string;
	organizationId?: string;
}

export interface CreateCodeBasedDocumentRecordsOutput {
	documents: Array<{
		id: string;
		type: string;
		title: string;
	}>;
}

/**
 * Create 4 ProjectDocument records with GENERATING status for the code-based setup.
 * Returns the document IDs for use by the document generation child workflows.
 */
export async function createCodeBasedDocumentRecords(
	input: CreateCodeBasedDocumentRecordsInput,
): Promise<CreateCodeBasedDocumentRecordsOutput> {
	const { projectId, userId, organizationId } = input;

	const documents = await Promise.all(
		CODE_BASED_DOCUMENTS.map((doc) =>
			db.projectDocument.create({
				data: {
					projectId,
					type: doc.type,
					title: doc.title,
					content: "",
					status: "GENERATING",
					generationProgress: 0,
					generationStartedAt: new Date(),
					userId,
					organizationId: organizationId ?? null,
				},
			}),
		),
	);

	return {
		documents: documents.map((d) => ({
			id: d.id,
			type: d.type,
			title: d.title,
		})),
	};
}
