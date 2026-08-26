/**
 * Internal Code Search Endpoint
 *
 * Called by LangGraph agents to search repository code, fetch file contents,
 * and list directory structures via GitHub/Azure DevOps APIs.
 *
 * Auth: Uses X-AI-Token JWT. Validates tenant isolation and project access.
 *
 * Pattern: Same as /api/internal/project-context-search
 */

import { AI_TOKEN_HEADER, verifyAIToken } from "@repo/ai-token";
import {
	type CodeSearchResult,
	type FileContentResult,
	getRepositoryFile,
	listRepositoryStructure,
	type RepositoryStructure,
	searchRepositoryCode,
} from "@repo/connectors";
import {
	db,
	getProjectReposForCodeSearch,
	hasProjectAccess,
	parseRepoUrl,
} from "@repo/database";
import type { WorkflowIntegrationProvider } from "@repo/database/prisma/zod";
import { getGitHubAccessToken } from "@repo/integrations";
import { resolveFreshRepoTokenForRow } from "@repo/integrations/repo-auth";
import { decryptApiKey } from "@repo/utils";
import { NextResponse } from "next/server";
import { extractAdoProject } from "./ado-project";

export const runtime = "nodejs";

interface ResolvedCredentials {
	provider: "GITHUB" | "AZURE_DEVOPS";
	token: string;
	owner: string;
	repo: string;
	/** Undefined when the default branch is unknown — the connector then lets
	 * the provider resolve its own default (never a hardcoded "main"). */
	branch?: string;
	azureProject?: string;
}

/**
 * Resolve credentials for code search with fallback chain:
 * 1. Project-level integration (ProjectRepositoryIntegration — team shared credentials)
 * 2. User's OAuth integration (WorkflowIntegration — personal GitHub/ADO OAuth)
 *
 * Both branches refresh expired GitHub access tokens on demand so a day-old
 * connection does not silently 401 the next time the AI Assistant runs.
 */
async function resolveCodeSearchCredentials(
	projectId: string,
	project: {
		repositoryUrl: string | null;
		repositoryOwner: string | null;
		repositoryName: string | null;
		defaultBranch: string | null;
	},
	userId: string,
	organizationId: string | undefined,
): Promise<ResolvedCredentials | null> {
	// Strategy 1: Project-level integration (shared team credentials)
	const repos = await getProjectReposForCodeSearch(projectId);
	if (repos.length > 0) {
		const repo = repos[0];
		const { token, stale } = await resolveFreshRepoTokenForRow(repo, {
			userId,
			organizationId,
		});
		// `stale` means refresh failed AND the stored token is already past
		// expiry. Using it would 401; fall through to Strategy 2, where the
		// caller's own GitHub OAuth may still be good.
		if (token && !stale) {
			return {
				provider: repo.provider as "GITHUB" | "AZURE_DEVOPS",
				token,
				owner: repo.owner,
				repo: repo.repo,
				branch: repo.branch,
				azureProject:
					extractAdoProject(repo.repositoryUrl) ??
					repo.azureOrganization ??
					undefined,
			};
		}
	}

	// Strategy 2: User's OAuth integration (WorkflowIntegration)
	if (
		!project.repositoryUrl ||
		!project.repositoryOwner ||
		!project.repositoryName
	) {
		return null;
	}

	const parsed = parseRepoUrl(project.repositoryUrl);
	if (!parsed) {
		return null;
	}

	const provider = parsed.provider;

	// GitHub: delegate to the shared helper, which handles decrypt + expiry
	// check + refresh through the per-integration concurrent-refresh lock.
	if (provider === "GITHUB") {
		const token = await getGitHubAccessToken(userId, organizationId);
		if (!token) {
			return null;
		}
		return {
			provider: "GITHUB",
			token,
			owner: project.repositoryOwner,
			repo: project.repositoryName,
			branch: project.defaultBranch ?? undefined,
		};
	}

	// Azure DevOps OAuth: no on-demand refresh yet.
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	const integration = await db.workflowIntegration.findFirst({
		where: {
			userId,
			...orgFilter,
			provider: provider as WorkflowIntegrationProvider,
			isActive: true,
		},
		select: { credentials: true },
		orderBy: { updatedAt: "desc" },
	});

	if (!integration?.credentials) {
		return null;
	}

	// Credentials are stored encrypted — decrypt then parse as JSON
	let creds: Record<string, unknown>;
	try {
		const credString =
			typeof integration.credentials === "string"
				? integration.credentials
				: JSON.stringify(integration.credentials);
		const decrypted = decryptApiKey(credString);
		creds = JSON.parse(decrypted) as Record<string, unknown>;
	} catch {
		// If decryption fails, try parsing as plain JSON (dev/test scenarios)
		try {
			creds = (
				typeof integration.credentials === "object"
					? integration.credentials
					: JSON.parse(integration.credentials as string)
			) as Record<string, unknown>;
		} catch {
			return null;
		}
	}

	const token =
		(creds.access_token as string) ||
		(creds.token as string) ||
		(creds.GITHUB_TOKEN as string) ||
		(creds.apiKey as string);

	if (!token) {
		return null;
	}

	return {
		provider: provider as "GITHUB" | "AZURE_DEVOPS",
		token,
		owner: project.repositoryOwner,
		repo: project.repositoryName,
		branch: project.defaultBranch ?? undefined,
		azureProject:
			provider === "AZURE_DEVOPS"
				? (extractAdoProject(project.repositoryUrl!) ?? undefined)
				: undefined,
	};
}

type CodeSearchAction = "search" | "get-file" | "list-structure";

export async function POST(req: Request) {
	try {
		const body = await req.json();
		const { projectId, action, ...params } = body as {
			projectId: string;
			action: CodeSearchAction;
			query?: string;
			path?: string;
			language?: string;
			directory?: string;
			maxResults?: number;
			branch?: string;
		};

		if (!projectId || !action) {
			return NextResponse.json(
				{ error: "Missing required fields: projectId, action" },
				{ status: 400 },
			);
		}

		// Auth: Extract user/org context from AI token
		const aiToken = req.headers.get(AI_TOKEN_HEADER);
		if (!aiToken) {
			return NextResponse.json(
				{ error: "Authentication required: X-AI-Token header missing" },
				{ status: 401 },
			);
		}

		const payload = await verifyAIToken(aiToken);
		if (!payload || !payload.valid) {
			return NextResponse.json(
				{ error: "Invalid AI token" },
				{ status: 401 },
			);
		}

		const userId = payload.claims.sub;
		const organizationId = payload.claims.org;

		// Verify user has access AND tenant context matches (XOR isolation)
		const access = await hasProjectAccess(
			projectId,
			userId,
			organizationId,
		);
		if (!access) {
			return NextResponse.json(
				{ error: "You do not have access to this project" },
				{ status: 403 },
			);
		}

		// Enforce tenant XOR isolation + get repo info
		const project = await db.project.findUnique({
			where: { id: projectId },
			select: {
				organizationId: true,
				repositoryUrl: true,
				repositoryOwner: true,
				repositoryName: true,
				defaultBranch: true,
			},
		});
		if (!project) {
			return NextResponse.json(
				{ error: "Project not found" },
				{ status: 404 },
			);
		}
		const projectOrgId = project.organizationId ?? undefined;
		if (projectOrgId !== organizationId) {
			return NextResponse.json(
				{ error: "Tenant context mismatch" },
				{ status: 403 },
			);
		}

		// Resolve repo credentials with fallback chain:
		// 1. Project-level integration (shared team credentials)
		// 2. User's GitHub/ADO OAuth integration (workflow_integration)
		const resolved = await resolveCodeSearchCredentials(
			projectId,
			project,
			userId,
			organizationId,
		);
		if (!resolved) {
			return NextResponse.json(
				{
					error: "No repository credentials found. Connect a repository in project settings or set up a GitHub integration.",
				},
				{ status: 404 },
			);
		}

		const baseParams = resolved;

		switch (action) {
			case "search": {
				if (!params.query) {
					return NextResponse.json(
						{ error: "Missing required field: query" },
						{ status: 400 },
					);
				}
				const results: CodeSearchResult[] = await searchRepositoryCode({
					...baseParams,
					query: params.query,
					path: params.path,
					language: params.language,
					maxResults: Math.min(params.maxResults ?? 10, 30),
				});
				return NextResponse.json({
					results,
					totalCount: results.length,
				});
			}

			case "get-file": {
				if (!params.path) {
					return NextResponse.json(
						{ error: "Missing required field: path" },
						{ status: 400 },
					);
				}
				const file: FileContentResult = await getRepositoryFile({
					...baseParams,
					path: params.path,
				});
				return NextResponse.json({ file });
			}

			case "list-structure": {
				const structure: RepositoryStructure =
					await listRepositoryStructure({
						...baseParams,
						directory: params.directory,
					});
				return NextResponse.json({
					structure,
					totalFiles: structure.totalFiles,
					totalDirectories: structure.totalDirectories,
				});
			}

			default:
				return NextResponse.json(
					{
						error: `Unknown action: ${action}. Valid actions: search, get-file, list-structure`,
					},
					{ status: 400 },
				);
		}
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		console.error("[Internal Code Search] Error:", errorMessage);

		return NextResponse.json({ error: errorMessage }, { status: 500 });
	}
}
