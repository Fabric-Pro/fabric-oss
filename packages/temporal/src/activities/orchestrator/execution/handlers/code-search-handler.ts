/**
 * Code Search Handler
 *
 * Handles code search, file retrieval, and repository structure listing
 * during orchestrator step execution. Resolves repository credentials
 * from project integrations and calls the code search APIs.
 */

import type {
	RepoCredentialRow,
	ResolvedRepoToken,
} from "@repo/integrations/repo-auth";
import type { ExecuteStepInput, ExecuteStepOutput } from "../../types";
import type {
	HandlerContext,
	HandlerResult,
	StepHandler,
	ToolCallRecord,
} from "./types";

const CODE_SEARCH_TOOLS = new Set([
	"code_search",
	"code_file_get",
	"code_tree",
	"code_search_semantic",
]);

export class CodeSearchHandler implements StepHandler {
	readonly name = "code-search";
	readonly capabilities = [
		"code_search",
		"code_file",
		"code_tree",
		"code_search_semantic",
	];

	canHandle(input: ExecuteStepInput): boolean {
		const app = input.step.app;
		const executor = input.step.executor;

		return Boolean(
			(app && CODE_SEARCH_TOOLS.has(app)) ||
				(executor && CODE_SEARCH_TOOLS.has(executor)),
		);
	}

	async execute(context: HandlerContext): Promise<HandlerResult> {
		const { input } = context;
		const toolName = input.step.app || input.step.executor || "code_search";

		console.log(`[CodeSearchHandler] Executing: ${toolName}`);

		try {
			const output = await this.executeCodeSearch(input, toolName);
			return {
				handled: true,
				output,
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			console.error("[CodeSearchHandler] Failed:", error);
			return {
				handled: false,
				error: `Code search ${toolName} failed: ${errorMessage}`,
				shouldFallback: false,
			};
		}
	}

	/**
	 * Search the AST-aware code index in Qdrant.
	 * Returns formatted code chunks from the indexed repository.
	 */
	private async searchCodeIndex(
		projectId: string,
		query: string,
		userId: string,
		organizationId: string | undefined,
		language?: string,
	): Promise<string[]> {
		const { getProjectCodeIndexes } = await import("@repo/database");
		const codeIndexes = await getProjectCodeIndexes(projectId);
		// Search spans every connected repo, so any READY repo makes the index
		// usable. Search results are project-scoped below (all repos).
		if (!codeIndexes.some((index) => index.status === "READY")) {
			return [];
		}

		const { generateEmbedding } = await import("@repo/rag/lib/embedding");
		const { generateSparseVector } = await import(
			"@repo/rag/lib/embedding/sparse"
		);
		const { ensureCollection, getCollectionLayout } = await import(
			"@repo/rag/lib/collection-manager"
		);
		const { qdrantClient } = await import(
			"@repo/rag/lib/project-contexts/client"
		);

		const tenantContext = {
			userId,
			organizationId: organizationId ?? undefined,
		};
		const embeddingResult = await generateEmbedding(query, tenantContext);

		const collectionName = await ensureCollection(
			"project-contexts",
			organizationId,
		);
		const layout = await getCollectionLayout(
			"project-contexts",
			organizationId,
		);

		// Build filter
		const must: any[] = [
			{ key: "projectId", match: { value: projectId } },
			{
				key: "contextType",
				match: { any: ["CODE_FILE", "CODE_FILE_SUMMARY"] },
			},
		];
		if (language) {
			must.push({ key: "language", match: { value: language } });
		}

		// Search with hybrid (dense + sparse)
		const sparse = generateSparseVector(query);

		let searchResults: any[];
		if (layout.supportsHybrid && layout.denseVectorName) {
			const queryResult = await qdrantClient.query(collectionName, {
				prefetch: [
					{
						query: embeddingResult.embedding,
						using: layout.denseVectorName,
						limit: 20,
						filter: { must },
					},
					{
						query: {
							indices: sparse.indices,
							values: sparse.values,
						},
						using: layout.sparseVectorName ?? "sparse",
						limit: 20,
						filter: { must },
					},
				],
				query: { fusion: "rrf" },
				limit: 10,
				with_payload: true,
			});
			searchResults = queryResult.points ?? [];
		} else {
			const queryResult = await qdrantClient.query(collectionName, {
				query: embeddingResult.embedding,
				limit: 10,
				filter: { must },
				with_payload: true,
			});
			searchResults = queryResult.points ?? [];
		}

		return searchResults.map((point: any) => {
			const payload = point.payload ?? {};
			const filePath = payload.filePath ?? "unknown";
			const content = payload.content ?? "";
			const symbolName = payload.symbolName ?? "";
			const symbolType = payload.symbolType ?? "";
			const symbol = symbolName ? ` (${symbolType}: ${symbolName})` : "";
			return `### ${filePath}${symbol}\n\`\`\`\n${content}\n\`\`\``;
		});
	}

	private async executeCodeSearch(
		input: ExecuteStepInput,
		toolName: string,
	): Promise<ExecuteStepOutput> {
		const startTime = Date.now();
		const stepInputs = input.step.inputs as
			| Record<string, unknown>
			| undefined;
		const projectId = input.projectId;

		const toolCalls: ToolCallRecord[] = [];

		if (!projectId) {
			const result =
				"No project is attached. Code search requires a project with a connected repository.";
			toolCalls.push({
				id: `code-search-${Date.now()}`,
				name: toolName,
				args: stepInputs ?? {},
				result: { message: "No project attached" },
				status: "success",
				durationMs: Date.now() - startTime,
			});
			return {
				outputs: { response: result, toolResults: toolCalls },
				variables: {},
				toolCalls,
				response: result,
			};
		}

		// Dynamic imports to avoid circular dependencies
		const { db, getProjectReposForCodeSearch, parseRepoUrl } = await import(
			"@repo/database"
		);
		const { decryptApiKey } = await import("@repo/utils");
		const { resolveFreshRepoTokenForRow } = await import(
			"@repo/integrations/repo-auth"
		);
		const { getGitHubAccessToken } = await import(
			"@repo/integrations/github"
		);
		const {
			searchRepositoryCode,
			getRepositoryFile,
			listRepositoryStructure,
		} = await import("@repo/connectors");

		// Resolve credentials for all connected repositories
		const allRepoParams = await resolveAllCredentials(
			projectId,
			input.userId,
			input.organizationId,
			{
				db,
				getProjectReposForCodeSearch,
				parseRepoUrl,
				decryptApiKey,
				resolveFreshRepoTokenForRow,
				getGitHubAccessToken,
			},
		);

		if (allRepoParams.length === 0) {
			const result =
				"No repository credentials found. Connect a repository in project settings or set up a GitHub integration.";
			toolCalls.push({
				id: `code-search-${Date.now()}`,
				name: toolName,
				args: stepInputs ?? {},
				result: { message: "No credentials" },
				status: "error",
				durationMs: Date.now() - startTime,
			});
			return {
				outputs: { response: result, toolResults: toolCalls },
				variables: {},
				toolCalls,
				response: result,
			};
		}

		// Helper: find repos matching an optional owner/repo filter
		const filterRepos = (repoFilter?: string): ResolvedParams[] => {
			if (!repoFilter) {
				return allRepoParams;
			}
			const [filterOwner, filterRepo] = repoFilter.split("/");
			return allRepoParams.filter(
				(r) => r.owner === filterOwner && r.repo === filterRepo,
			);
		};

		// Helper: prefix path with owner/repo when multiple repos are in scope
		const isMultiRepo = allRepoParams.length > 1;
		const prefixPath = (
			repoParams: ResolvedParams,
			path: string,
		): string =>
			isMultiRepo
				? `${repoParams.owner}/${repoParams.repo}: ${path}`
				: path;

		let result = "";
		const apiStartTime = Date.now();

		switch (toolName) {
			case "code_search": {
				const query =
					(stepInputs?.query as string) ||
					input.step.description ||
					"";
				if (!query) {
					result = "Query is required for code search.";
					break;
				}

				const mode = (stepInputs?.mode as string) || "hybrid";
				const repoFilter = stepInputs?.repo as string | undefined;
				const targetRepos = filterRepos(repoFilter);
				const apiResults: string[] = [];
				let indexedResults: string[] = [];

				// API search across all repos in parallel
				if (mode !== "indexed" && targetRepos.length > 0) {
					const maxPerRepo = Math.max(
						3,
						Math.floor(10 / targetRepos.length),
					);
					const searchPromises = targetRepos.map(
						async (repoParams) => {
							try {
								const searchResults =
									await searchRepositoryCode({
										...repoParams,
										query,
										path: stepInputs?.path as
											| string
											| undefined,
										language: stepInputs?.language as
											| string
											| undefined,
										maxResults: maxPerRepo,
									});
								return searchResults.map((r) => {
									const snippets =
										r.matchedSnippets.length > 0
											? r.matchedSnippets.join("\n---\n")
											: "(no preview)";
									const tagPrefix = repoParams.roleTag
										? `${repoParams.roleTag}: `
										: "";
									return `### ${tagPrefix}${prefixPath(repoParams, r.filePath)}\n${snippets}`;
								});
							} catch (error) {
								console.warn(
									`[CodeSearchHandler] Search failed for ${repoParams.owner}/${repoParams.repo}:`,
									error,
								);
								return [];
							}
						},
					);
					const resultsPerRepo =
						await Promise.allSettled(searchPromises);
					for (const r of resultsPerRepo) {
						if (r.status === "fulfilled") {
							apiResults.push(...r.value);
						}
					}
				}

				// Indexed search — skip when a specific repo filter is set
				// because the Qdrant index doesn't support per-repo filtering
				if (mode !== "api" && !repoFilter) {
					try {
						const semanticResults = await this.searchCodeIndex(
							projectId,
							query,
							input.userId,
							input.organizationId,
							stepInputs?.language as string | undefined,
						);
						indexedResults = semanticResults;
					} catch {
						// Index not available, continue with API results only
					}
				}

				const allResults = [...apiResults, ...indexedResults];

				if (allResults.length === 0) {
					result = `No code matches found for "${query}".`;
				} else {
					result = `Found ${allResults.length} code matches across ${targetRepos.length} repo(s):\n\n${allResults.join("\n\n")}`;
				}

				toolCalls.push({
					id: `code-search-${Date.now()}`,
					name: toolName,
					args: {
						query,
						path: stepInputs?.path,
						mode,
						repo: repoFilter,
					},
					result: {
						totalCount: allResults.length,
						apiCount: apiResults.length,
						indexedCount: indexedResults.length,
						reposSearched: targetRepos.length,
					},
					status: "success",
					durationMs: Date.now() - apiStartTime,
				});
				break;
			}

			case "code_search_semantic": {
				const query =
					(stepInputs?.query as string) ||
					input.step.description ||
					"";
				if (!query) {
					result = "Query is required for semantic code search.";
					break;
				}

				try {
					const semanticResults = await this.searchCodeIndex(
						projectId,
						query,
						input.userId,
						input.organizationId,
						stepInputs?.language as string | undefined,
					);

					if (semanticResults.length === 0) {
						result = `No semantic code matches found for "${query}".`;
					} else {
						result = `Found ${semanticResults.length} semantic code matches:\n\n${semanticResults.join("\n\n")}`;
					}
				} catch (error) {
					result = `Semantic code search unavailable: ${error instanceof Error ? error.message : error}. Use code_search for API-based search.`;
				}

				toolCalls.push({
					id: `code-search-semantic-${Date.now()}`,
					name: toolName,
					args: { query },
					result: { message: result.slice(0, 200) },
					status: "success",
					durationMs: Date.now() - apiStartTime,
				});
				break;
			}

			case "code_file_get": {
				const filePath = stepInputs?.path as string;
				if (!filePath) {
					result = "File path is required.";
					break;
				}
				const repoFilter = stepInputs?.repo as string | undefined;
				const targetRepos = filterRepos(repoFilter);

				// Try each repo until file is found
				let found = false;
				for (const repoParams of targetRepos) {
					try {
						const file = await getRepositoryFile({
							...repoParams,
							path: filePath,
						});

						if (file.content || file.isBinary) {
							if (file.isBinary) {
								result = `File ${prefixPath(repoParams, filePath)} is a binary file.`;
							} else {
								const truncNote = file.isTruncated
									? "\n\n(Truncated at 100KB)"
									: "";
								result = `### ${prefixPath(repoParams, file.path)} (${file.size} bytes)\n\`\`\`\n${file.content}\n\`\`\`${truncNote}`;
							}
							toolCalls.push({
								id: `code-file-${Date.now()}`,
								name: toolName,
								args: {
									path: filePath,
									repo: `${repoParams.owner}/${repoParams.repo}`,
								},
								result: {
									path: file.path,
									size: file.size,
									isBinary: file.isBinary,
								},
								status: "success",
								durationMs: Date.now() - apiStartTime,
							});
							found = true;
							break;
						}
					} catch {
						// File not in this repo, try next
					}
				}
				if (!found) {
					result = `File ${filePath} not found in any connected repository.`;
					toolCalls.push({
						id: `code-file-${Date.now()}`,
						name: toolName,
						args: { path: filePath, repo: repoFilter },
						result: { message: "Not found" },
						status: "error",
						durationMs: Date.now() - apiStartTime,
					});
				}
				break;
			}

			case "code_tree": {
				const repoFilter = stepInputs?.repo as string | undefined;
				const targetRepos = filterRepos(repoFilter);
				const treeResults: string[] = [];
				let totalFiles = 0;
				let totalDirs = 0;

				const maxEntriesPerRepo = Math.max(
					100,
					Math.floor(500 / targetRepos.length),
				);

				for (const repoParams of targetRepos) {
					try {
						const structure = await listRepositoryStructure({
							...repoParams,
							directory: stepInputs?.directory as
								| string
								| undefined,
						});

						if (structure.entries.length > 0) {
							const repoHeader = isMultiRepo
								? `\n## ${repoParams.owner}/${repoParams.repo}\n`
								: "";
							const tree = structure.entries
								.slice(0, maxEntriesPerRepo)
								.map((e) => {
									const icon =
										e.type === "directory" ? "📁" : "📄";
									return `${icon} ${e.path}`;
								})
								.join("\n");
							const truncNote = structure.truncated
								? "\n(Tree was truncated)"
								: "";
							treeResults.push(
								`${repoHeader}${tree}${truncNote}`,
							);
							totalFiles += structure.totalFiles;
							totalDirs += structure.totalDirectories;
						}
					} catch (error) {
						console.warn(
							`[CodeSearchHandler] Tree listing failed for ${repoParams.owner}/${repoParams.repo}:`,
							error,
						);
					}
				}

				if (treeResults.length === 0) {
					result = "No files found in connected repositories.";
				} else {
					result = `Repository structure (${totalFiles} files, ${totalDirs} dirs across ${targetRepos.length} repo(s)):\n\n${treeResults.join("\n")}`;
				}

				toolCalls.push({
					id: `code-tree-${Date.now()}`,
					name: toolName,
					args: {
						directory: stepInputs?.directory,
						repo: repoFilter,
					},
					result: { totalFiles, totalDirectories: totalDirs },
					status: "success",
					durationMs: Date.now() - apiStartTime,
				});
				break;
			}

			default:
				result = `Unknown code search tool: ${toolName}`;
		}

		const durationMs = Date.now() - startTime;
		console.log(
			`[CodeSearchHandler] ${toolName} completed in ${durationMs}ms`,
		);

		return {
			outputs: {
				response: result,
				toolResults: toolCalls,
			},
			variables: {},
			toolCalls,
			response: result,
		};
	}
}

interface ResolvedParams {
	provider: "GITHUB" | "AZURE_DEVOPS";
	token: string;
	owner: string;
	repo: string;
	/** Undefined when the default branch is unknown — the connector then lets
	 * the provider resolve its own default (never a hardcoded "main"). */
	branch?: string;
	azureProject?: string;
	roleTag?: string;
}

/**
 * Resolve credentials for ALL connected repositories.
 * Returns an array of ResolvedParams, one per repo with valid credentials.
 *
 * Fallback chain per repo:
 * 1. Project-level integration (shared team credentials)
 * 2. User's OAuth integration (WorkflowIntegration) — only for legacy single-repo
 */
async function resolveAllCredentials(
	projectId: string,
	userId: string,
	organizationId: string | undefined,
	deps: {
		db: any;
		getProjectReposForCodeSearch: (id: string) => Promise<any[]>;
		parseRepoUrl: (
			url: string,
		) => { provider: string; owner: string; name: string } | null;
		decryptApiKey: (key: string) => string;
		resolveFreshRepoTokenForRow: (
			row: RepoCredentialRow,
			ctx?: { userId?: string | null; organizationId?: string | null },
		) => Promise<ResolvedRepoToken>;
		getGitHubAccessToken: (
			userId: string,
			organizationId?: string,
		) => Promise<string | null>;
	},
): Promise<ResolvedParams[]> {
	const results: ResolvedParams[] = [];

	// Strategy 1: All project-level integrations
	const repos = await deps.getProjectReposForCodeSearch(projectId);
	for (const repo of repos) {
		// Skip providers not yet supported by code search connectors
		if (repo.provider !== "GITHUB" && repo.provider !== "AZURE_DEVOPS") {
			console.warn(
				`[CodeSearchHandler] Skipping repo ${repo.owner}/${repo.repo} — provider ${repo.provider} not supported for code search`,
			);
			continue;
		}
		// Canonical resolver: refreshes a near-expiry GitHub/GitLab OAuth token
		// rather than handing the agent an 8-hour-old dead one.
		const { token } = await deps.resolveFreshRepoTokenForRow(repo, {
			userId,
			organizationId,
		});
		if (token) {
			const adoProjectFromUrl =
				repo.repositoryUrl?.match(
					/dev\.azure\.com\/[^/]+\/([^/]+)\/_git\//i,
				)?.[1] ??
				repo.repositoryUrl?.match(
					/\.visualstudio\.com\/([^/]+)\/_git\//i,
				)?.[1];

			results.push({
				provider: repo.provider as "GITHUB" | "AZURE_DEVOPS",
				token,
				owner: repo.owner,
				repo: repo.repo,
				branch: repo.branch,
				roleTag: repo.roleTag ?? undefined,
				azureProject:
					adoProjectFromUrl ?? repo.azureOrganization ?? undefined,
			});
		} else {
			console.warn(
				`[CodeSearchHandler] Skipping repo ${repo.owner}/${repo.repo} — no valid credentials`,
			);
		}
	}

	if (results.length > 0) {
		return results;
	}

	// Strategy 2: Fall back to user's OAuth integration + legacy project repo URL
	// (only when no ProjectRepositoryIntegration rows exist)
	const project = await deps.db.project.findUnique({
		where: { id: projectId },
		select: {
			repositoryUrl: true,
			repositoryOwner: true,
			repositoryName: true,
			defaultBranch: true,
		},
	});

	if (
		!project?.repositoryUrl ||
		!project.repositoryOwner ||
		!project.repositoryName
	) {
		return [];
	}

	const parsed = deps.parseRepoUrl(project.repositoryUrl);
	if (!parsed) {
		return [];
	}

	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	// GitHub goes through the refresh-aware getter — the sibling Next.js route
	// that serves the same agent tool already did this, but this Temporal-side
	// copy raw-decrypted an 8h-lived token. Non-GitHub providers keep the
	// legacy decrypt (ADO here is PAT-based and does not expire).
	let token: string | undefined;
	if (parsed.provider === "GITHUB") {
		token =
			(await deps.getGitHubAccessToken(userId, organizationId)) ??
			undefined;
	} else {
		const integration = await deps.db.workflowIntegration.findFirst({
			where: {
				userId,
				...orgFilter,
				provider: parsed.provider,
				isActive: true,
			},
			select: { credentials: true },
			orderBy: { updatedAt: "desc" },
		});

		if (!integration?.credentials) {
			return [];
		}

		let creds: Record<string, unknown>;
		try {
			const credString =
				typeof integration.credentials === "string"
					? integration.credentials
					: JSON.stringify(integration.credentials);
			const decrypted = deps.decryptApiKey(credString);
			creds = JSON.parse(decrypted) as Record<string, unknown>;
		} catch {
			try {
				creds = (
					typeof integration.credentials === "object"
						? integration.credentials
						: JSON.parse(integration.credentials as string)
				) as Record<string, unknown>;
			} catch {
				return [];
			}
		}

		token =
			(creds.access_token as string) ||
			(creds.token as string) ||
			(creds.GITHUB_TOKEN as string) ||
			(creds.apiKey as string);
	}

	if (!token) {
		return [];
	}

	const adoProject =
		project.repositoryUrl?.match(
			/dev\.azure\.com\/[^/]+\/([^/]+)\/_git\//i,
		)?.[1] ??
		project.repositoryUrl?.match(
			/\.visualstudio\.com\/([^/]+)\/_git\//i,
		)?.[1];

	return [
		{
			provider: parsed.provider as "GITHUB" | "AZURE_DEVOPS",
			token,
			owner: project.repositoryOwner,
			repo: project.repositoryName,
			branch: project.defaultBranch ?? undefined,
			azureProject:
				parsed.provider === "AZURE_DEVOPS"
					? (adoProject ?? undefined)
					: undefined,
		},
	];
}
