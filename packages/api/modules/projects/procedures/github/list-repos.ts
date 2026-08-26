/**
 * List GitHub Repositories (Grouped by Organization)
 *
 * Strategy 1 (preferred): Uses the GitHub workflow integration (OAuth token from WorkflowIntegration table).
 * Strategy 2 (fallback): Uses the GitHub MCP server if configured.
 *
 * Supports manual org search since tokens may have limited scopes for
 * automatic org discovery.
 */

import {
	db,
	getMcpConfigForTenantAndServer,
	getMcpServerByKey,
	hasProjectAccess,
} from "@repo/database";
import {
	getAuthenticatedUser,
	getGitHubAccessToken,
	listUserRepositories,
	searchGitHubRepositories,
} from "@repo/integrations/github";
import { resolveFreshRepoTokenForRow } from "@repo/integrations/repo-auth";
import {
	closeMcpClient,
	createMcpClientForConfig,
	type McpClientType,
} from "@repo/mcp";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

// ============================================================================
// Shared types and helpers
// ============================================================================

interface GitHubRepoRaw {
	name: string;
	full_name: string;
	description: string | null;
	private: boolean;
	html_url: string;
	language: string | null;
	default_branch: string;
	updated_at: string;
	stargazers_count: number;
	fork: boolean;
	owner: {
		login: string;
		avatar_url?: string;
	};
}

interface RepoGroup {
	owner: string;
	ownerType: "user" | "org";
	repos: ReturnType<typeof transformRepo>[];
}

interface ListReposResult {
	configured: boolean;
	username: string | null;
	groups: RepoGroup[];
	error: string | null;
}

function transformRepo(repo: GitHubRepoRaw) {
	return {
		name: repo.name,
		fullName: repo.full_name,
		description: repo.description,
		isPrivate: repo.private,
		htmlUrl: repo.html_url,
		language: repo.language,
		defaultBranch: repo.default_branch,
		updatedAt: repo.updated_at,
		stars: repo.stargazers_count ?? 0,
		isFork: repo.fork ?? false,
		owner: repo.owner?.login ?? repo.full_name?.split("/")[0] ?? "",
	};
}

function groupRepos(allRepos: GitHubRepoRaw[], username: string): RepoGroup[] {
	const usernameLower = username.toLowerCase();
	const reposByOwner = new Map<
		string,
		{ ownerType: "user" | "org"; repos: GitHubRepoRaw[] }
	>();

	for (const repo of allRepos) {
		const ownerLogin =
			repo.owner?.login ?? repo.full_name?.split("/")[0] ?? "";
		if (!ownerLogin) {
			continue;
		}

		if (!reposByOwner.has(ownerLogin)) {
			const isUser = ownerLogin.toLowerCase() === usernameLower;
			reposByOwner.set(ownerLogin, {
				ownerType: isUser ? "user" : "org",
				repos: [],
			});
		}
		reposByOwner.get(ownerLogin)?.repos.push(repo);
	}

	const groups: RepoGroup[] = [];

	// User's own repos first
	const userGroup = reposByOwner.get(username);
	if (userGroup && userGroup.repos.length > 0) {
		groups.push({
			owner: username,
			ownerType: "user",
			repos: userGroup.repos.map(transformRepo),
		});
	}

	// Org repos sorted alphabetically
	const orgEntries = [...reposByOwner.entries()]
		.filter(([login]) => login.toLowerCase() !== usernameLower)
		.sort((a, b) => a[0].localeCompare(b[0]));

	for (const [ownerLogin, data] of orgEntries) {
		if (data.repos.length > 0) {
			groups.push({
				owner: ownerLogin,
				ownerType: "org",
				repos: data.repos.map(transformRepo),
			});
		}
	}

	return groups;
}

// ============================================================================
// Strategy 1: Workflow Integration (direct GitHub API)
// ============================================================================

async function listReposViaIntegration(
	token: string,
	searchOrg?: string,
): Promise<ListReposResult> {
	// Get authenticated user — throw if token is invalid so we fall through to MCP
	const user = await getAuthenticatedUser(token);
	if (!user) {
		throw new Error(
			"GitHub token could not authenticate. Falling through to MCP.",
		);
	}

	const username = user.login;

	// If searching a specific org
	if (searchOrg) {
		const orgName = searchOrg.trim();
		const orgRepos = await searchGitHubRepositories(
			token,
			`org:${orgName} sort:updated`,
		);

		console.log(
			`[listGitHubRepos:integration] Searched org:${orgName}, found ${orgRepos.length} repos`,
		);

		return {
			configured: true,
			username,
			groups:
				orgRepos.length > 0
					? [
							{
								owner: orgName,
								ownerType: "org",
								repos: (
									orgRepos as unknown as GitHubRepoRaw[]
								).map(transformRepo),
							},
						]
					: [],
			error:
				orgRepos.length === 0
					? `No repositories found for "${orgName}". Check the organization name or your access.`
					: null,
		};
	}

	// Auto-discovery: fetch all repos
	const allRepos: GitHubRepoRaw[] = [];
	const seenFullNames = new Set<string>();
	const discoveredOrgs = new Set<string>();
	const usernameLower = username.toLowerCase();

	const addRepos = (repos: GitHubRepoRaw[]) => {
		for (const repo of repos) {
			if (!seenFullNames.has(repo.full_name)) {
				seenFullNames.add(repo.full_name);
				allRepos.push(repo);
			}
			const owner =
				repo.owner?.login ?? repo.full_name?.split("/")[0] ?? "";
			if (owner && owner.toLowerCase() !== usernameLower) {
				discoveredOrgs.add(owner);
			}
		}
	};

	// Get user's repos (includes org repos they have access to)
	const userRepos = await listUserRepositories(token, 100);
	addRepos(userRepos as unknown as GitHubRepoRaw[]);
	console.log(
		"[listGitHubRepos:integration] /user/repos returned",
		userRepos.length,
		"repos, discovered orgs:",
		[...discoveredOrgs].join(", ") || "none",
	);

	// For each discovered org, get full repo list via search
	for (const orgName of discoveredOrgs) {
		try {
			const orgRepos = await searchGitHubRepositories(
				token,
				`org:${orgName} sort:updated`,
			);
			addRepos(orgRepos as unknown as GitHubRepoRaw[]);
			console.log(
				`[listGitHubRepos:integration] org:${orgName} returned ${orgRepos.length} repos`,
			);
		} catch {
			// ignore
		}
	}

	const groups = groupRepos(allRepos, username);

	console.log(
		"[listGitHubRepos:integration] Result: groups=",
		groups.length,
		"totalRepos=",
		groups.reduce((sum, g) => sum + g.repos.length, 0),
	);

	return { configured: true, username, groups, error: null };
}

// ============================================================================
// Strategy 2: MCP Server (fallback)
// ============================================================================

/**
 * Parse MCP tool response — MCP returns { content: [...], isError: false }
 */
function parseMcpTextResponse<T>(result: unknown): T | null {
	if (result === null || result === undefined) {
		return null;
	}

	const mcpResult = result as { content?: unknown[]; isError?: boolean };
	if (mcpResult.isError) {
		return null;
	}

	if (mcpResult.content && Array.isArray(mcpResult.content)) {
		const textContent = mcpResult.content.find(
			(c): c is { type: string; text: string } =>
				c !== null &&
				typeof c === "object" &&
				"type" in c &&
				(c as { type?: string }).type === "text",
		);

		if (textContent?.text) {
			try {
				return JSON.parse(textContent.text) as T;
			} catch {
				return textContent.text as T;
			}
		}
	}

	return result as T;
}

async function executeMcpTool(
	tools: Record<string, unknown>,
	toolName: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const mcpTool = tools[toolName] as
		| {
				execute: (
					args: Record<string, unknown>,
					ctx: { toolCallId: string; messages: unknown[] },
				) => Promise<unknown>;
		  }
		| undefined;

	if (!mcpTool) {
		return null;
	}

	return mcpTool.execute(args, {
		toolCallId: `${toolName}-${Date.now()}`,
		messages: [],
	});
}

async function searchReposMcp(
	tools: Record<string, unknown>,
	query: string,
	perPage = 100,
): Promise<GitHubRepoRaw[]> {
	const result = await executeMcpTool(tools, "search_repositories", {
		query,
		perPage,
		per_page: perPage,
		page: 1,
	});

	const parsed = parseMcpTextResponse<
		{ items: GitHubRepoRaw[]; total_count?: number } | GitHubRepoRaw[]
	>(result);

	if (!parsed) {
		return [];
	}
	if (Array.isArray(parsed)) {
		return parsed;
	}
	if (parsed.items && Array.isArray(parsed.items)) {
		return parsed.items;
	}
	return [];
}

async function listReposViaMcp(
	userId: string,
	organizationId: string | null,
	searchOrg?: string,
): Promise<ListReposResult> {
	let mcpClient: McpClientType | undefined;

	try {
		// Find GitHub MCP config
		let configId: string | null = null;

		// Try seeded "github" server key
		const githubServer = await getMcpServerByKey("github", {
			userId,
			organizationId: organizationId ?? undefined,
			includeSystem: true,
		});

		if (githubServer) {
			const config = await getMcpConfigForTenantAndServer({
				mcpServerId: githubServer.id,
				userId,
				organizationId: organizationId ?? undefined,
			});
			if (config?.enabled) {
				configId = config.id;
			}
		}

		// Search for any enabled config with "github" in its name
		if (!configId) {
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
				orderBy: { updatedAt: "desc" },
			});

			if (githubConfig?.enabled) {
				configId = githubConfig.id;
			}
		}

		if (!configId) {
			return {
				configured: false,
				username: null,
				groups: [],
				error: null,
			};
		}

		// Create MCP client
		const clientResult = await createMcpClientForConfig({
			configId,
			userId,
			organizationId: organizationId ?? undefined,
		});
		mcpClient = clientResult.client;

		const tools = await mcpClient.tools();

		// Get authenticated username
		let username: string | null = null;
		const getMeResult = await executeMcpTool(tools, "get_me", {});
		if (getMeResult) {
			const meData = parseMcpTextResponse<{ login?: string }>(
				getMeResult,
			);
			if (meData?.login) {
				username = meData.login;
			}
		}

		if (!tools.search_repositories) {
			return {
				configured: true,
				username,
				groups: [],
				error: `search_repositories tool not found. Available: ${Object.keys(tools).join(", ")}`,
			};
		}

		if (!username) {
			return {
				configured: true,
				username: null,
				groups: [],
				error: "Could not determine GitHub username. Please verify your GitHub token has the 'user' scope.",
			};
		}

		// If searching a specific org
		if (searchOrg) {
			const orgName = searchOrg.trim();
			const orgRepos = await searchReposMcp(
				tools,
				`org:${orgName} sort:updated`,
			);

			return {
				configured: true,
				username,
				groups:
					orgRepos.length > 0
						? [
								{
									owner: orgName,
									ownerType: "org",
									repos: orgRepos.map(transformRepo),
								},
							]
						: [],
				error:
					orgRepos.length === 0
						? `No repositories found for "${orgName}".`
						: null,
			};
		}

		// Auto-discovery
		const allRepos: GitHubRepoRaw[] = [];
		const seenFullNames = new Set<string>();
		const discoveredOrgs = new Set<string>();
		const usernameLower = username.toLowerCase();

		const addRepos = (repos: GitHubRepoRaw[]) => {
			for (const repo of repos) {
				if (!seenFullNames.has(repo.full_name)) {
					seenFullNames.add(repo.full_name);
					allRepos.push(repo);
				}
				const owner =
					repo.owner?.login ?? repo.full_name?.split("/")[0] ?? "";
				if (owner && owner.toLowerCase() !== usernameLower) {
					discoveredOrgs.add(owner);
				}
			}
		};

		const privateRepos = await searchReposMcp(
			tools,
			"is:private sort:updated",
		);
		addRepos(privateRepos);

		const userRepos = await searchReposMcp(
			tools,
			`user:${username} sort:updated`,
		);
		addRepos(userRepos);

		for (const orgName of discoveredOrgs) {
			try {
				const orgRepos = await searchReposMcp(
					tools,
					`org:${orgName} sort:updated`,
				);
				addRepos(orgRepos);
			} catch {
				// ignore
			}
		}

		const groups = groupRepos(allRepos, username);

		return { configured: true, username, groups, error: null };
	} catch (err) {
		console.error("[listGitHubRepos:mcp] Error:", err);
		return {
			configured: true,
			username: null,
			groups: [],
			error:
				err instanceof Error
					? err.message
					: "Failed to list GitHub repositories via MCP",
		};
	} finally {
		await closeMcpClient(mcpClient);
	}
}

// ============================================================================
// Main Procedure
// ============================================================================

/**
 * AUTHORIZATION: Uses tenantProtectedProcedure (authenticated + tenant isolation)
 * Tries workflow integration first, then falls back to GitHub MCP server.
 */
export const listGitHubReposProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.INTEGRATION_READ))
	.route({
		method: "GET",
		path: "/projects/github/repos",
		tags: ["Projects", "GitHub"],
		summary: "List GitHub repositories, grouped by owner",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			searchOrg: z.string().optional(),
			/** When provided, also checks project-level shared credentials */
			projectId: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Strategy 1: Try user's workflow integration (preferred — no MCP server needed)
		const token = await getGitHubAccessToken(
			userId,
			organizationId ?? undefined,
		);

		if (token) {
			console.log(
				"[listGitHubRepos] Using workflow integration (OAuth token) from",
				organizationId ? `org:${organizationId}` : "personal",
				"context",
			);
			try {
				return await listReposViaIntegration(token, input.searchOrg);
			} catch (err) {
				console.warn(
					"[listGitHubRepos] Workflow integration failed:",
					err,
				);
			}
		}

		// Strategy 2: Try project-level shared credentials (team access)
		if (input.projectId) {
			const hasAccess = await hasProjectAccess(
				input.projectId,
				userId,
				organizationId,
			);
			if (hasAccess) {
				const projectIntegration =
					await db.projectRepositoryIntegration.findFirst({
						where: {
							projectId: input.projectId,
							provider: "GITHUB",
							status: "ACTIVE",
							encryptedAccessToken: { not: null },
						},
					});

				if (projectIntegration?.encryptedAccessToken) {
					console.log(
						"[listGitHubRepos] Using project-level shared credentials from project:",
						input.projectId,
					);
					try {
						// Refresh-aware: a GitHub App user token dies after 8h, so
						// decrypting the stored one here used to serve a dead token.
						const { token: projectToken } =
							await resolveFreshRepoTokenForRow(
								{
									...projectIntegration,
									integrationId: projectIntegration.id,
								},
								{ userId, organizationId },
							);
						if (!projectToken) {
							throw new Error(
								"No usable project-level GitHub token",
							);
						}
						return await listReposViaIntegration(
							projectToken,
							input.searchOrg,
						);
					} catch (err) {
						console.warn(
							"[listGitHubRepos] Project-level credentials failed:",
							err,
						);
					}
				}
			}
		}

		// Strategy 3: Fall back to MCP server
		console.log("[listGitHubRepos] Trying MCP server fallback");
		const mcpResult = await listReposViaMcp(
			userId,
			organizationId ?? null,
			input.searchOrg,
		);

		if (!mcpResult.configured) {
			return {
				configured: false,
				username: null,
				groups: [],
				error: "GitHub not connected. Please connect your GitHub account in Settings → Workflow Integrations, or configure a GitHub MCP server.",
			};
		}

		return mcpResult;
	});
