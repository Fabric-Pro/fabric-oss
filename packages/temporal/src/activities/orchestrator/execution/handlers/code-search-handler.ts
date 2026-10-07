/**
 * Code Search Handler
 *
 * Handles code search, file retrieval, and repository structure listing
 * during orchestrator step execution. Resolves repository credentials
 * from project integrations and calls the code search APIs.
 */

import type { RepositoryStructure } from "@repo/connectors";
// Static, not `await import(...)`: the worker runs under tsx, where a dynamic
// import of an ES-module package (@repo/integrations) fails to link any named
// import it takes from a CommonJS package such as @repo/database. A static
// import compiles to require() and loads. Guarded by
// src/__tests__/worker-dynamic-imports.test.ts.
import { getGitHubAccessToken } from "@repo/integrations/github";
import {
	type RepoCredentialRow,
	type ResolvedRepoToken,
	resolveFreshRepoTokenForRow,
} from "@repo/integrations/repo-auth";
// Plain constants module (no imports): ties the listing budget to the
// chat loop's result cap.
import { rethrowIfDispatchStopped } from "@repo/utils/dispatch-guard";
import { TOOL_RESULTS } from "../../../../workflows/orchestrator/orchestrator-config";
import { codeIndexUnavailableResult } from "../../../direct-chat/code-search-repositories";
import type { ExecuteStepInput, ExecuteStepOutput } from "../../types";
import type {
	HandlerContext,
	HandlerResult,
	StepHandler,
	ToolCallRecord,
} from "./types";

/**
 * Character budget for one `code_tree` result. The chat loop shows a tool
 * result whole only up to `TOOL_RESULTS.maxChars` and summarizes anything
 * longer, which loses the range line and next offset. The 2,000 characters
 * of margin cover the adapter's `{ error }` / JSON envelope and the notes.
 */
const CODE_TREE_OUTPUT_BUDGET = TOOL_RESULTS.maxChars - 2_000;

/**
 * Character budget for the failed-repository list in a `code_search` result
 * that also carries matches, which the handler does not otherwise bound.
 */
const CODE_SEARCH_FAILURE_NOTE_BUDGET = 1_500;

/** Longest `repo` argument echoed back whole in an error. */
const ECHO_MAX_REPO_REF = 200;

/** Character budget for the connected-repository list in an error. */
const CONNECTED_LIST_BUDGET = 1_500;

/**
 * Longest `directory` argument a `code_tree` result echoes; a longer one is
 * referred to as "the requested directory" / "the same directory".
 */
const ECHO_MAX_DIRECTORY = 300;

/** Tools whose `repo` argument must name a repository connected here. */
const REPO_FILTERED_TOOLS = new Set([
	"code_search",
	"code_file_get",
	"code_tree",
]);

/**
 * An error's class name for logs, and nothing else from it: messages and
 * stacks can carry tokens. Anything not a plain identifier is "Error".
 */
function errorClassName(error: unknown): string {
	const name = error instanceof Error ? error.name : typeof error;
	return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "Error";
}

/**
 * A repository reference as lower-cased `owner/name`, or a bare `name`.
 * A URL — GitHub, `dev.azure.com`, or legacy `<org>.visualstudio.com` —
 * goes through the shared `parseRepoUrl` (@repo/database), which gives the
 * owner the connected rows store (the organization for Azure DevOps).
 */
function normalizeRepoRef(
	ref: string,
	parseRepoUrl: (url: string) => { owner: string; name: string } | null,
): string {
	const value = ref.trim();
	if (/^[a-z][a-z\d+.-]*:\/\//i.test(value) || /^git@/i.test(value)) {
		const parsed = parseRepoUrl(value);
		return parsed ? `${parsed.owner}/${parsed.name}`.toLowerCase() : "";
	}
	const lowered = value.toLowerCase();
	return lowered.endsWith(".git") ? lowered.slice(0, -4) : lowered;
}

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
			// Inside a chat turn's dispatch guard a stop is not a step failure
			// to report or fall back from; a no-op outside one.
			rethrowIfDispatchStopped(error);
			// Class name only: the message can carry a token or a URL with one.
			console.error("[CodeSearchHandler] Failed", {
				toolName,
				errorClass: errorClassName(error),
			});
			return {
				handled: false,
				error: `Code search ${toolName} failed unexpectedly; try again shortly.`,
				shouldFallback: false,
			};
		}
	}

	/**
	 * Search the AST-aware code index in Qdrant.
	 * Returns formatted code chunks from the indexed repository, or the index
	 * status when no repository's index is searchable yet.
	 */
	private async searchCodeIndex(
		projectId: string,
		query: string,
		userId: string,
		organizationId: string | undefined,
		language?: string,
	): Promise<string[] | { unavailableStatus: string }> {
		const { getProjectCodeIndexes } = await import("@repo/database");
		const codeIndexes = await getProjectCodeIndexes(projectId);
		// Search spans every connected repo, so any READY repo makes the index
		// usable. Search results are project-scoped below (all repos).
		if (!codeIndexes.some((index) => index.status === "READY")) {
			return { unavailableStatus: codeIndexes[0]?.status ?? "missing" };
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

		// Dynamic imports to avoid circular dependencies. The
		// @repo/integrations readers are imported statically above: see there.
		const { db, getProjectReposForCodeSearch, parseRepoUrl } = await import(
			"@repo/database"
		);
		const { decryptApiKey } = await import("@repo/utils");
		const {
			searchRepositoryCode,
			getRepositoryFile,
			listRepositoryStructure,
		} = await import("@repo/connectors");

		// Resolve credentials for all connected repositories
		const {
			readable: allRepoParams,
			connected,
			legacyLookupFailed,
		} = await resolveAllCredentials(
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

		// A failed step whose message is the full sentence: the chat's catalog
		// adapter reports a failed step by this result, so it is what the
		// model is told.
		const failStep = (message: string): ExecuteStepOutput => {
			toolCalls.push({
				id: `code-search-${Date.now()}`,
				name: toolName,
				args: stepInputs ?? {},
				result: { message },
				status: "error",
				durationMs: Date.now() - startTime,
			});
			return {
				outputs: { response: message, toolResults: toolCalls },
				variables: {},
				toolCalls,
				response: message,
			};
		};

		// A failed lookup of the legacy repository proves nothing about what
		// is connected, so no answer here may conclude a repository is absent.
		const LOOKUP_FAILED =
			"Could not check this project's repository connections; try again shortly.";

		if (connected.length === 0) {
			if (legacyLookupFailed) {
				return failStep(LOOKUP_FAILED);
			}
			return failStep(
				"No repository credentials found. Connect a repository in project settings or set up a GitHub integration.",
			);
		}

		// Repository references compared case-insensitively: `owner/name`, a
		// bare name, or a URL through the shared parser.
		const matchesRef = (
			repoFilter: string,
			ref: { owner: string; repo: string },
		): boolean => {
			const wanted = normalizeRepoRef(repoFilter, parseRepoUrl);
			// An unparseable URL matches nothing (never "every repository").
			if (!wanted) {
				return false;
			}
			return wanted.includes("/")
				? `${ref.owner}/${ref.repo}`.toLowerCase() === wanted
				: ref.repo.toLowerCase() === wanted;
		};
		const unusableReason = (repo: ConnectedRepo): string =>
			repo.status === "unsupported"
				? "its provider is not supported for code reads."
				: "its credentials could not be used. Reconnect it in the project's repository settings.";
		const describeUnusable = (repo: ConnectedRepo): string =>
			`Repository ${repo.owner}/${repo.repo} is connected to this project, but ${unusableReason(repo)}`;

		// Membership is the project's own repository rows (`connected`), kept
		// apart from the readable set: a repository whose credentials failed
		// is still connected, and is reported as unreadable, not missing.
		const requestedRepo =
			typeof stepInputs?.repo === "string" ? stepInputs.repo.trim() : "";
		// The model's own reference, echoed back bounded: the advice must
		// not outgrow the result it is part of.
		const requestedRepoText =
			requestedRepo.length <= ECHO_MAX_REPO_REF
				? requestedRepo
				: `${requestedRepo.slice(0, ECHO_MAX_REPO_REF)}… (${requestedRepo.length} characters)`;
		if (REPO_FILTERED_TOOLS.has(toolName) && requestedRepo) {
			const named = connected.filter((c) => matchesRef(requestedRepo, c));
			if (named.length === 0) {
				if (legacyLookupFailed) {
					return failStep(LOOKUP_FAILED);
				}
				return failStep(
					`Repository ${requestedRepoText} is not connected to this project. Connected: ${boundedList(
						connected.map((c) => `${c.owner}/${c.repo}`),
						", ",
						CONNECTED_LIST_BUDGET,
					)}.`,
				);
			}
			if (!named.some((c) => c.status === "readable")) {
				return failStep(
					named.length === 1
						? describeUnusable(named[0])
						: `Repository ${requestedRepoText} is connected to this project, but none of its matches could be read. Reconnect it in the project's repository settings.`,
				);
			}
		}

		if (allRepoParams.length === 0 && legacyLookupFailed) {
			return failStep(LOOKUP_FAILED);
		}
		if (allRepoParams.length === 0) {
			// Each connected repository with its own reason (credentials or
			// provider), bounded like every other list here.
			return failStep(
				connected.length === 1
					? describeUnusable(connected[0])
					: `None of this project's connected repositories could be read. ${boundedList(
							connected.map(describeUnusable),
							" ",
							CODE_TREE_OUTPUT_BUDGET - 200,
						)}`,
			);
		}

		// Helper: find repos matching an optional repository filter —
		// `owner/name`, a bare name or a URL, compared case-insensitively.
		const filterRepos = (repoFilter?: string): ResolvedParams[] => {
			if (!repoFilter?.trim()) {
				return allRepoParams;
			}
			return allRepoParams.filter((r) => matchesRef(repoFilter, r));
		};

		// Connected repositories in scope that cannot be read at all (their
		// credentials failed, or their provider is unsupported). They are
		// never in `allRepoParams`, so `filterRepos` skips them: without this
		// an unfiltered call would answer "no matches" / "not found" for
		// repositories it never looked in. Same `owner/name: reason` shape as
		// a read that failed, so the notes read alike. A readable repository
		// is never listed here, so none is reported twice.
		const unusableInScope = (repoFilter?: string): string[] =>
			connected
				.filter(
					(c) =>
						c.status !== "readable" &&
						(!repoFilter?.trim() || matchesRef(repoFilter, c)),
				)
				.map(
					(c) =>
						`${c.owner}/${c.repo}: connected to this project, but ${unusableReason(c)}`,
				);

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
				// A repository whose search failed, with the reason. Reporting
				// it as "no matches" would tell the model the code does not
				// exist when it was never searched.
				const searchFailures: string[] = [];
				let indexedResults: string[] = [];
				const apiSearchRan =
					mode !== "indexed" && targetRepos.length > 0;
				// Repositories the API search actually completed on.
				let reposSearchedOk = 0;

				// API search across all repos in parallel
				if (apiSearchRan) {
					const maxPerRepo = Math.max(
						3,
						Math.floor(10 / targetRepos.length),
					);
					const searchPromises = targetRepos.map(
						async (
							repoParams,
						): Promise<{ lines: string[]; failure?: string }> => {
							const repoName = `${repoParams.owner}/${repoParams.repo}`;
							try {
								const { results: searchResults, error } =
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
								if (error) {
									return {
										lines: [],
										failure: `${repoName}: ${error.message}`,
									};
								}
								return {
									lines: searchResults.map((r) => {
										const snippets =
											r.matchedSnippets.length > 0
												? r.matchedSnippets.join(
														"\n---\n",
													)
												: "(no preview)";
										const tagPrefix = repoParams.roleTag
											? `${repoParams.roleTag}: `
											: "";
										return `### ${tagPrefix}${prefixPath(repoParams, r.filePath)}\n${snippets}`;
									}),
								};
							} catch (error) {
								console.warn(
									"[CodeSearchHandler] Search threw",
									{
										repo: repoName,
										errorClass: errorClassName(error),
									},
								);
								return {
									lines: [],
									failure: `${repoName}: the search failed unexpectedly; try again shortly.`,
								};
							}
						},
					);
					const resultsPerRepo =
						await Promise.allSettled(searchPromises);
					for (const r of resultsPerRepo) {
						if (r.status === "fulfilled") {
							apiResults.push(...r.value.lines);
							if (r.value.failure) {
								searchFailures.push(r.value.failure);
							} else {
								reposSearchedOk += 1;
							}
						}
					}
					// Connected but unusable repositories were not searched
					// either.
					searchFailures.push(...unusableInScope(repoFilter));
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
						if (Array.isArray(semanticResults)) {
							indexedResults = semanticResults;
						}
					} catch (error) {
						// A stop is not an unavailable index (a no-op outside a
						// chat turn's dispatch guard).
						rethrowIfDispatchStopped(error);
						// Index not available, continue with API results only
					}
				}

				const allResults = [...apiResults, ...indexedResults];

				// Failed only when nothing was found anywhere and no
				// repository could be searched. Some repositories failing is a
				// partial answer, said so below.
				const failed =
					apiSearchRan &&
					allResults.length === 0 &&
					searchFailures.length > 0 &&
					reposSearchedOk === 0;

				if (failed) {
					result = `Could not search for "${query}". ${boundedList(
						searchFailures,
						" ",
						CODE_TREE_OUTPUT_BUDGET - 200,
					)} This is a search failure, not proof that the code does not exist.`;
				} else if (allResults.length === 0) {
					result =
						searchFailures.length > 0
							? `No code matches found for "${query}" in the repositories that could be searched. Could not search ${boundedList(
									searchFailures,
									" ",
									CODE_SEARCH_FAILURE_NOTE_BUDGET,
								)} That is a search failure for those repositories, not proof that the code does not exist there.`
							: `No code matches found for "${query}".`;
				} else {
					const failureNote =
						searchFailures.length > 0
							? `\n\nCould not search ${boundedList(
									searchFailures,
									" ",
									CODE_SEARCH_FAILURE_NOTE_BUDGET,
								)}`
							: "";
					result = `Found ${allResults.length} code matches across ${targetRepos.length} repo(s):\n\n${allResults.join("\n\n")}${failureNote}`;
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
					// A failed step is reported by this message, so it holds
					// the full sentence.
					result: failed
						? { message: result }
						: {
								totalCount: allResults.length,
								apiCount: apiResults.length,
								indexedCount: indexedResults.length,
								reposSearched: apiSearchRan
									? reposSearchedOk
									: targetRepos.length,
								...(searchFailures.length > 0
									? { failedRepos: searchFailures.length }
									: {}),
							},
					status: failed ? "error" : "success",
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

					if (!Array.isArray(semanticResults)) {
						// Not "no matches": the index cannot be searched yet,
						// and saying nothing matched would be a confident
						// wrong answer (Fizzy #2578).
						result = codeIndexUnavailableResult(
							semanticResults.unavailableStatus,
						).message;
					} else if (semanticResults.length === 0) {
						result = `No semantic code matches found for "${query}".`;
					} else {
						result = `Found ${semanticResults.length} semantic code matches:\n\n${semanticResults.join("\n\n")}`;
					}
				} catch (error) {
					rethrowIfDispatchStopped(error);
					console.warn("[CodeSearchHandler] Semantic search threw", {
						errorClass: errorClassName(error),
					});
					result =
						"Semantic code search is unavailable right now. Use code_search for API-based search.";
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

				// Try each repo until file is found. A repo that refused or
				// failed the read is remembered with its reason: reporting it as
				// "not found" would send the model looking for a file that may
				// well exist. A folder at the path is remembered too.
				let found = false;
				const readFailures: string[] = [];
				let nonFile:
					| {
							repoParams: ResolvedParams;
							objectType: "dir" | "symlink" | "submodule";
					  }
					| undefined;
				for (const repoParams of targetRepos) {
					const repoName = `${repoParams.owner}/${repoParams.repo}`;
					try {
						const file = await getRepositoryFile({
							...repoParams,
							path: filePath,
						});

						if (file.error) {
							if (file.error.kind === "not_a_file") {
								nonFile ??= {
									repoParams,
									// Older readers set no type: a folder was
									// the only case they reported.
									objectType: file.error.objectType ?? "dir",
								};
							} else if (file.error.kind !== "not_found") {
								readFailures.push(
									`${repoName}: ${file.error.message}`,
								);
							}
							continue;
						}

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
								args: { path: filePath, repo: repoName },
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

						// Read succeeded with no error and no bytes: the file
						// exists and is empty.
						result = `File ${prefixPath(repoParams, file.path)} exists and is empty (0 bytes).`;
						toolCalls.push({
							id: `code-file-${Date.now()}`,
							name: toolName,
							args: { path: filePath, repo: repoName },
							result: {
								path: file.path,
								size: 0,
								isBinary: false,
							},
							status: "success",
							durationMs: Date.now() - apiStartTime,
						});
						found = true;
						break;
					} catch (error) {
						console.warn("[CodeSearchHandler] File read threw", {
							repo: repoName,
							errorClass: errorClassName(error),
						});
						readFailures.push(
							`${repoName}: the read failed unexpectedly; try again shortly.`,
						);
					}
				}
				if (!found && nonFile) {
					// Not a failure: the path exists, as something other than
					// a regular file. Only a folder can be listed — code_tree's
					// directory argument lists exactly its entries.
					const where = prefixPath(nonFile.repoParams, filePath);
					const isDirectory = nonFile.objectType === "dir";
					result = isDirectory
						? `${where} is a directory, not a file — list its entries with code_tree (directory="${filePath}"), paging with offset if the listing continues.`
						: nonFile.objectType === "symlink"
							? `${where} is a symbolic link, not a regular file, so it has no content to read here.`
							: `${where} is a git submodule (a pointer to another repository), not a regular file, so it has no content to read here.`;
					toolCalls.push({
						id: `code-file-${Date.now()}`,
						name: toolName,
						args: {
							path: filePath,
							repo: `${nonFile.repoParams.owner}/${nonFile.repoParams.repo}`,
						},
						result: isDirectory
							? { path: filePath, isDirectory: true }
							: {
									path: filePath,
									objectType: nonFile.objectType,
								},
						status: "success",
						durationMs: Date.now() - apiStartTime,
					});
				} else if (!found) {
					// Repositories the read was attempted in and failed, counted
					// before the unreadable ones are added: only the former can
					// say the file was missing from the others.
					const failedChecks = readFailures.length;
					readFailures.push(...unusableInScope(repoFilter));
					result =
						readFailures.length > 0
							? `Could not read ${filePath}. ${readFailures.join(" ")}${
									failedChecks < targetRepos.length
										? " The file was not found in the other connected repositories."
										: ""
								} This is a read failure, not proof that the file does not exist.`
							: legacyLookupFailed
								? `File ${filePath} not found in the repositories that could be checked.`
								: `File ${filePath} not found in any connected repository.`;
					toolCalls.push({
						id: `code-file-${Date.now()}`,
						name: toolName,
						args: { path: filePath, repo: repoFilter },
						// The full sentence: the catalog adapter reports a failed
						// step by this result, so it is what the model is told.
						result: { message: result },
						status: "error",
						durationMs: Date.now() - apiStartTime,
					});
				}
				break;
			}

			case "code_tree": {
				const repoFilter = stepInputs?.repo as string | undefined;
				const directory = stepInputs?.directory as string | undefined;
				const targetRepos = filterRepos(repoFilter);
				const listFailures: string[] = [];
				const listed: Array<{
					repoParams: ResolvedParams;
					structure: ListedTree;
				}> = [];
				let totalFiles = 0;
				let totalDirs = 0;
				let pastEnd = false;

				// `offset` skips entries already shown, so a listing larger than
				// a page can be read to the end instead of stopping at its first
				// slice.
				const offset = readListingOffset(stepInputs?.offset);
				// `depth` keeps a large repository's top levels to a page or
				// two; without it they are spread through the whole listing.
				const depth = readListingDepth(stepInputs?.depth);
				const maxEntriesPerRepo = Math.max(
					100,
					Math.floor(500 / Math.max(1, targetRepos.length)),
				);

				for (const repoParams of targetRepos) {
					const repoName = `${repoParams.owner}/${repoParams.repo}`;
					try {
						const fetched = await listRepositoryStructure({
							...repoParams,
							directory,
						});
						const structure =
							depth === undefined || fetched.error
								? fetched
								: limitTreeDepth(fetched, directory, depth);
						if (structure.error) {
							listFailures.push(
								`${repoName}: ${structure.error.message}`,
							);
							continue;
						}
						totalFiles += structure.totalFiles;
						totalDirs += structure.totalDirectories;
						listed.push({ repoParams, structure });
					} catch (error) {
						console.warn("[CodeSearchHandler] Tree listing threw", {
							repo: repoName,
							errorClass: errorClassName(error),
						});
						listFailures.push(
							`${repoName}: the listing failed unexpectedly; try again shortly.`,
						);
					}
				}

				// Connected but unusable repositories were not listed either.
				listFailures.push(...unusableInScope(repoFilter));

				// The directory as the result names it: echoed when short,
				// referred to when not, so it never outgrows the budget.
				const echoDirectory =
					!!directory && directory.length <= ECHO_MAX_DIRECTORY;
				const underDirectory = echoDirectory
					? `under ${directory}`
					: "under the requested directory";
				const depthNote =
					depth === undefined
						? ""
						: `, ${depth === 1 ? "1 level" : `${depth} levels`} deep`;
				const preamble = `Repository structure — a directory listing of paths, not file contents (${totalFiles} files, ${totalDirs} dirs across ${targetRepos.length} repo(s)${depthNote}). Read a file with code_file_get.\n\n`;
				const shown = listed.filter(
					({ structure }) =>
						structure.entries.length > 0 || structure.truncated,
				);
				// Room kept for the closing notes (repositories left out,
				// listings that failed), so they never push the result over
				// the budget either.
				const tailReserve = Math.min(
					3_000,
					300 + 120 * (shown.length + listFailures.length),
				);
				// This listing's own arguments, which the advice for a
				// repository left out repeats so its separate request shows
				// the view its count describes. Stated once, outside the
				// bounded list of repositories, and reserved on top of the
				// notes; an overlong one is named rather than echoed.
				const listingArgsFor = (offsetText: string | null) =>
					[
						...(directory ? [`directory="${directory}"`] : []),
						...(depth === undefined ? [] : [`depth=${depth}`]),
						...(offsetText === null
							? []
							: [`offset=${offsetText}`]),
					].join(", ");
				const listingArgs = listingArgsFor(
					offset > 0 ? String(offset) : null,
				);
				const sharedArgs = !listingArgs
					? ""
					: listingArgs.length <= 300
						? ` (${listingArgs})`
						: " with the same directory, depth and offset as this request";
				// Page sizes must not depend on the offset (see `pageSize`
				// below), so the room for these arguments is reserved as if
				// the offset had as many digits as the longest listing: the
				// echoed text is never longer than that, whichever form it
				// takes. Only an offset past the end of every listing, whose
				// blocks hold no entries, can widen the reservation.
				const worstOffset = "9".repeat(
					Math.max(
						String(offset).length,
						...shown.map(
							({ structure }) =>
								String(structure.entries.length).length,
						),
					),
				);
				const reservedArgs = Math.max(
					sharedArgs.length,
					Math.min(303, listingArgsFor(worstOffset).length + 3),
				);
				const available =
					CODE_TREE_OUTPUT_BUDGET -
					preamble.length -
					tailReserve -
					reservedArgs;
				// Each block after the first is preceded by a blank line.
				const SEPARATOR = 2;
				// The share a repository's page size is computed against: an
				// even split of the offset-independent `available`, less a
				// separator. Admission below may use a larger leftover share,
				// but a page sized for this one always fits it.
				const sizingShare =
					Math.floor(available / Math.max(1, shown.length)) -
					SEPARATOR;
				// Only a listing shown alone promises a stride: in a
				// multi-repository result the repo-filtered follow-up gets a
				// larger page, so a stride read there would not hold.
				const promiseStride = shown.length === 1;

				/**
				 * One repository's block, sized against `sizingShare` and
				 * admitted only within `share` characters; null when not
				 * even its range line and first entry fit.
				 *
				 * Every page of a listing holds the same number of entries
				 * (the last may hold fewer), so offset k·N always starts a
				 * page and a model can request several pages at once. Pages
				 * used to be filled greedily to the character budget, so
				 * their entry counts varied with path length and a stride
				 * extrapolated from page 1 skipped entries (Fizzy #2941).
				 */
				const renderBlock = (
					repoParams: ResolvedParams,
					structure: ListedTree,
					share: number,
				): string | null => {
					const repoName = `${repoParams.owner}/${repoParams.repo}`;
					const repoHeader = isMultiRepo ? `## ${repoName}\n` : "";
					const total = structure.entries.length;
					// GitHub returns the whole recursive tree and `directory`
					// is filtered here, so narrowing cannot reach entries a
					// truncated tree left out; Azure DevOps fetches the subtree
					// itself (`scopePath`), so narrowing there does.
					const fetchesSubtree =
						repoParams.provider === "AZURE_DEVOPS";
					const providerNote = structure.truncated
						? fetchesSubtree
							? "\nThe provider truncated this tree, so the listing and its counts are incomplete. Narrow it with directory to fetch a smaller subtree."
							: "\nThe provider truncated this repository's tree, so the listing and its counts are incomplete; the entries it left out cannot be listed here."
						: "";
					const narrowHint =
						(structure.truncated && !fetchesSubtree
							? ""
							: ", or narrow it with directory") +
						(depth === undefined
							? ". For an overview, depth=1 lists only the top level"
							: "");
					const fits = (block: string) =>
						block.length <= share ? block : null;

					if (total === 0) {
						// Only a truncated tree gets here: an empty, complete
						// listing is not "shown".
						return fits(
							`${repoHeader}No entries${directory ? ` ${underDirectory}` : ""} in the part of the tree the provider returned.${providerNote}`,
						);
					}
					if (offset >= total) {
						pastEnd = true;
						return fits(
							`${repoHeader}Offset ${offset} is past the end of this listing (${total} entries).${providerNote}`,
						);
					}
					const continueWith = (next: string) =>
						[
							`offset=${next}`,
							...(echoDirectory
								? [`directory="${directory}"`]
								: []),
							...(depth === undefined ? [] : [`depth=${depth}`]),
							...(isMultiRepo ? [`repo="${repoName}"`] : []),
						].join(", ") +
						(directory && !echoDirectory
							? " and the same directory as this request"
							: "");
					const continuingLine = (
						from: string,
						end: string,
						size: string,
						strides: string,
					) =>
						`Showing entries ${from}–${end} of ${total}.${promiseStride ? ` Every page of this listing but the last holds ${size} entries, so pages start at offsets 0, ${strides}, … (they can be requested together).` : ""} The listing continues: call code_tree again with ${continueWith(end)} for the next entries${narrowHint}.`;
					// The range line reserved for every page is the longest
					// one any page could need — every number as wide as three
					// times the total, which bounds each of them — so the
					// budget, and the page size, do not depend on the offset.
					// The end-of-listing line is shorter.
					const wide = "9".repeat(String(3 * total).length);
					const entryBudget =
						sizingShare -
						repoHeader.length -
						continuingLine(wide, wide, wide, `${wide}, ${wide}`)
							.length -
						providerNote.length -
						1;
					// Every line is capped at TREE_LINE_CAP, so an oversized
					// path cannot shrink the whole listing's page size or
					// leave its own page empty (Fizzy #2942). A page holds at
					// least floor(entryBudget / (TREE_LINE_CAP + 1)) entries
					// — about 18 for a single repository. Below that budget
					// (more than about ten repositories listed together) a
					// capped line can still exceed it: the page size may then
					// be 1 and the block may be named for a separate request,
					// whose repo-filtered budget holds it.
					const lines = structure.entries.map((e) => {
						const below = structure.below?.get(treeKey(e.path));
						return renderTreeLine(
							e.type === "directory" ? "📁" : "📄",
							e.path,
							below ? ` (${below} entries below)` : "",
							TREE_LINE_CAP,
						);
					});
					const pageSize = fixedPageSize(
						lines,
						Math.min(maxEntriesPerRepo, total),
						entryBudget,
					);
					const page: string[] = [];
					let used = 0;
					for (const line of lines.slice(offset, offset + pageSize)) {
						// A safety net only: `pageSize` already fits every
						// run of that many lines; this only drops a capped
						// line longer than a budget below TREE_LINE_CAP.
						if (used + line.length + 1 > entryBudget) {
							break;
						}
						page.push(line);
						used += line.length + 1;
					}
					if (page.length === 0) {
						return null;
					}
					const end = offset + page.length;
					const rangeLine =
						end < total
							? continuingLine(
									String(offset + 1),
									String(end),
									String(pageSize),
									`${pageSize}, ${2 * pageSize}`,
								)
							: `Showing entries ${offset + 1}–${end} of ${total} (end of listing).`;
					return fits(
						`${repoHeader}${rangeLine}${providerNote}\n${page.join("\n")}`,
					);
				};

				// Every block, including a repository's first, is admitted only
				// if it fits its share of what is left; a repository that does
				// not is named below for a separate request.
				const treeResults: string[] = [];
				const skipped: string[] = [];
				let spent = 0;
				shown.forEach(({ repoParams, structure }, index) => {
					const share = Math.floor(
						(available - spent) / (shown.length - index),
					);
					const separator = treeResults.length > 0 ? SEPARATOR : 0;
					const block = renderBlock(
						repoParams,
						structure,
						share - separator,
					);
					if (block === null) {
						skipped.push(
							`repo="${repoParams.owner}/${repoParams.repo}" (${structure.entries.length} entries${structure.truncated ? ", tree truncated by the provider" : ""})`,
						);
						return;
					}
					treeResults.push(block);
					spent += block.length + separator;
				});

				const skippedNote =
					skipped.length > 0
						? `\n\nNot listed, to keep this result within its size limit — request each separately with code_tree${sharedArgs} and its repo: ${boundedList(skipped, "; ", tailReserve / 2 - 120)}.`
						: "";
				const failureNote =
					listFailures.length > 0
						? `\n\nCould not list ${boundedList(listFailures, " ", tailReserve / 2 - 40)}`
						: "";

				const failed =
					treeResults.length === 0 &&
					skipped.length === 0 &&
					listFailures.length > 0;
				if (failed) {
					result = `Could not list the repository structure. ${boundedList(listFailures, " ", CODE_TREE_OUTPUT_BUDGET - 200)} This is a read failure, not an empty repository.`;
				} else if (treeResults.length === 0 && skipped.length === 0) {
					result = directory
						? `No files found ${underDirectory} in connected repositories.`
						: "No files found in connected repositories.";
				} else {
					result = `${preamble}${treeResults.join("\n\n")}${skippedNote}${failureNote}`;
				}

				toolCalls.push({
					id: `code-tree-${Date.now()}`,
					name: toolName,
					args: {
						directory,
						repo: repoFilter,
						offset,
						...(depth === undefined ? {} : { depth }),
					},
					result: failed
						? { message: result }
						: {
								totalFiles,
								totalDirectories: totalDirs,
								offset,
								...(pastEnd ? { pastEnd } : {}),
							},
					status: failed ? "error" : "success",
					durationMs: Date.now() - apiStartTime,
				});
				break;
			}

			default:
				result = `Unknown code search tool: ${toolName}`;
		}

		// A default (unfiltered) read may have missed the legacy repository.
		// A failed step is reported by its recorded message, so the note goes
		// there as well as on the response.
		if (
			legacyLookupFailed &&
			REPO_FILTERED_TOOLS.has(toolName) &&
			!requestedRepo
		) {
			const incomplete = `\n\nThis result may be incomplete: ${LOOKUP_FAILED}`;
			result += incomplete;
			for (const call of toolCalls) {
				const recorded = call.result as
					| { message?: unknown }
					| undefined;
				if (
					call.status === "error" &&
					typeof recorded?.message === "string"
				) {
					call.result = {
						...recorded,
						message: recorded.message + incomplete,
					};
				}
			}
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

/**
 * `items` joined with `separator`, at most `maxChars` long: items that do not
 * fit are counted in a closing "… and N more".
 */
function boundedList(
	items: string[],
	separator: string,
	maxChars: number,
): string {
	const out: string[] = [];
	let length = 0;
	for (const [index, item] of items.entries()) {
		const left = items.length - index - 1;
		const suffix = left > 0 ? ` … and ${left} more` : "";
		const next =
			length + (out.length > 0 ? separator.length : 0) + item.length;
		if (next + suffix.length > maxChars) {
			const remaining = items.length - index;
			return `${out.join(separator)}${out.length > 0 ? " " : ""}… and ${remaining} more`;
		}
		out.push(item);
		length = next;
	}
	return out.join(separator);
}

/** The fewest path characters a shortened line keeps, start and end. */
const MIN_SHORTENED_PATH = 24;

/**
 * Longest rendered `code_tree` entry line, newline excluded. A constant,
 * not a share of the budget: every view — one repository, several, any
 * offset — renders a given entry as the same string, so a larger budget
 * (a repo-filtered request) can only give an equal or larger page size,
 * since every run of N lines that fits the smaller budget fits the
 * larger one. A cap that grew with the budget lengthened the shortened
 * lines in the larger view and could make its page smaller.
 */
const TREE_LINE_CAP = 500;

/**
 * One `code_tree` entry line — `icon path annotation` — at most `cap`
 * characters. A longer one keeps the start of its path (the directory) and
 * its end (the file name), joined by "…", and says how long the path was;
 * the icon and the `(N entries below)` annotation stay whole. When `cap`
 * cannot hold even a minimally shortened path, the line is returned whole
 * and the caller's budget check leaves it out — a defence only: with
 * TREE_LINE_CAP that takes an annotation hundreds of characters long, and
 * the annotation is a short entry count.
 */
function renderTreeLine(
	icon: string,
	path: string,
	annotation: string,
	cap: number,
): string {
	const line = `${icon} ${path}${annotation}`;
	if (line.length <= cap) {
		return line;
	}
	const marker = ` [path shortened from ${path.length} characters]`;
	const room =
		cap - icon.length - 1 - "…".length - annotation.length - marker.length;
	if (room < MIN_SHORTENED_PATH) {
		return line;
	}
	const slash = path.lastIndexOf("/");
	const fileName = slash >= 0 ? path.length - slash : path.length;
	// The file name whole when it fits in three quarters of the room; the
	// start of the path keeps the rest.
	const tailLength = Math.min(
		Math.floor((room * 3) / 4),
		Math.max(Math.ceil(room / 2), fileName),
	);
	let head = path.slice(0, room - tailLength);
	let tail = path.slice(path.length - tailLength);
	// Never split a surrogate pair at either cut.
	if (/[\uD800-\uDBFF]$/.test(head)) {
		head = head.slice(0, -1);
	}
	if (/^[\uDC00-\uDFFF]/.test(tail)) {
		tail = tail.slice(1);
	}
	return `${icon} ${head}…${tail}${annotation}${marker}`;
}

/**
 * The largest page size, from 1 to `max`, at which every run of that many
 * consecutive lines — at any starting entry, not only multiples of the
 * size — fits `budget` characters, counting a newline after each line. A
 * run's length only grows with its size, so the largest size is found by
 * binary search, each candidate checked with one sliding window over the
 * listing. 1 when no size fits: the caller's per-line check then drops a
 * line that is longer than the whole budget.
 */
function fixedPageSize(
	lines: readonly string[],
	max: number,
	budget: number,
): number {
	const cost = lines.map((line) => line.length + 1);
	const fits = (size: number) => {
		let sum = 0;
		for (let i = 0; i < cost.length; i++) {
			sum += cost[i];
			if (i >= size) {
				sum -= cost[i - size];
			}
			if (sum > budget) {
				return false;
			}
		}
		return true;
	};
	let lo = 1;
	let hi = Math.max(1, max);
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (fits(mid)) {
			lo = mid;
		} else {
			hi = mid - 1;
		}
	}
	return lo;
}

/** A non-negative whole-number entry offset; anything else reads as 0. */
function readListingOffset(value: unknown): number {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim()
				? Number(value)
				: 0;
	return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

/**
 * A listing depth of at least 1, truncated to a whole number (1.9 reads as
 * 1); anything else — zero, negative, non-numeric — lists every level.
 */
function readListingDepth(value: unknown): number | undefined {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim()
				? Number(value)
				: Number.NaN;
	return Number.isFinite(parsed) && parsed >= 1
		? Math.trunc(parsed)
		: undefined;
}

/** A tree listing, with each deepest-listed folder's count of entries below it. */
type ListedTree = RepositoryStructure & {
	below?: ReadonlyMap<string, number>;
};

/** A path without leading, trailing or doubled slashes: `below`'s key. */
function treeKey(path: string): string {
	return path.split("/").filter(Boolean).join("/");
}

/**
 * The entries at most `depth` levels below `directory` (the root when
 * omitted), with counts and totals for that limited listing. Both providers
 * return paths from the repository root (GitHub `src/a.ts`, Azure DevOps
 * `/src/a.ts`) and already confined to `directory`, so an entry's level is
 * its segment count minus the directory's. The directory's own entry, which
 * Azure DevOps includes, is level 0 and is dropped.
 */
function limitTreeDepth(
	structure: RepositoryStructure,
	directory: string | undefined,
	depth: number,
): ListedTree {
	const segments = (path: string) => path.split("/").filter(Boolean);
	const base = directory ? segments(directory).length : 0;
	const entries: RepositoryStructure["entries"] = [];
	const below = new Map<string, number>();
	for (const entry of structure.entries) {
		const parts = segments(entry.path);
		const level = parts.length - base;
		if (level < 1) {
			continue;
		}
		if (level <= depth) {
			entries.push(entry);
			continue;
		}
		const folder = parts.slice(0, base + depth).join("/");
		below.set(folder, (below.get(folder) ?? 0) + 1);
	}
	return {
		...structure,
		entries,
		totalFiles: entries.filter((e) => e.type === "file").length,
		totalDirectories: entries.filter((e) => e.type === "directory").length,
		below,
	};
}

/** A repository the project has, whether or not its credentials work. */
interface ConnectedRepo {
	owner: string;
	repo: string;
	status: "readable" | "unreadable" | "unsupported";
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
 * Returns `readable`, one ResolvedParams per repo with valid credentials, and
 * `connected`: every repository the project has (its repository rows, or the
 * legacy project URL), each marked readable, unreadable (credentials could
 * not be used) or unsupported (provider). Membership comes from `connected`,
 * never from which credentials happened to resolve.
 *
 * Credential per repo:
 * 1. Project-level integration rows: the row's own credentials
 * 2. The legacy project repository (when no row names it, or its row's
 *    credentials failed): the caller's own GitHub token or WorkflowIntegration
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
): Promise<{
	readable: ResolvedParams[];
	connected: ConnectedRepo[];
	/** The legacy repository columns could not be read: `connected` may be missing one. */
	legacyLookupFailed: boolean;
}> {
	const results: ResolvedParams[] = [];
	const connected: ConnectedRepo[] = [];

	// Strategy 1: All project-level integrations
	const repos = await deps.getProjectReposForCodeSearch(projectId);
	for (const repo of repos) {
		const provider: unknown = repo.provider;
		// Providers code search cannot read stay connected, as unsupported.
		if (!isCodeSearchProvider(provider)) {
			console.warn(
				`[CodeSearchHandler] Skipping repo ${repo.owner}/${repo.repo} — provider ${String(provider)} not supported for code search`,
			);
			connected.push({
				owner: repo.owner,
				repo: repo.repo,
				status: "unsupported",
			});
			continue;
		}
		// Canonical resolver: refreshes a near-expiry GitHub/GitLab OAuth token
		// rather than handing the agent an 8-hour-old dead one. A failure
		// here makes this one repository unreadable, not the whole call.
		let token: string | null | undefined;
		try {
			({ token } = await deps.resolveFreshRepoTokenForRow(repo, {
				userId,
				organizationId,
			}));
		} catch (error) {
			console.warn("[CodeSearchHandler] Credential resolution threw", {
				repo: `${repo.owner}/${repo.repo}`,
				errorClass: errorClassName(error),
			});
			token = undefined;
		}
		connected.push({
			owner: repo.owner,
			repo: repo.repo,
			status: token ? "readable" : "unreadable",
		});
		if (token) {
			results.push({
				provider,
				token,
				owner: repo.owner,
				repo: repo.repo,
				branch: repo.branch,
				roleTag: repo.roleTag ?? undefined,
				azureProject:
					adoProjectFromUrl(repo.repositoryUrl) ??
					repo.azureOrganization ??
					undefined,
			});
		} else {
			console.warn(
				`[CodeSearchHandler] Skipping repo ${repo.owner}/${repo.repo} — no valid credentials`,
			);
		}
	}

	// Strategy 2: the project's legacy repository columns. Collected whether
	// or not an integration row resolved: connecting a new repository keeps
	// an existing legacy one (`syncLegacyProjectRepoOnConnect`), so it can
	// sit beside readable integrations and must not drop out of `connected`.
	// A failure reading the legacy columns must not stop the integrations
	// that already resolved from being read.
	let project: {
		repositoryUrl: string | null;
		repositoryOwner: string | null;
		repositoryName: string | null;
		defaultBranch: string | null;
	} | null;
	try {
		project = await deps.db.project.findUnique({
			where: { id: projectId },
			select: {
				repositoryUrl: true,
				repositoryOwner: true,
				repositoryName: true,
				defaultBranch: true,
			},
		});
	} catch (error) {
		console.warn("[CodeSearchHandler] Legacy repository lookup threw", {
			errorClass: errorClassName(error),
		});
		return { readable: results, connected, legacyLookupFailed: true };
	}
	if (
		!project?.repositoryUrl ||
		!project.repositoryOwner ||
		!project.repositoryName
	) {
		return { readable: results, connected, legacyLookupFailed: false };
	}

	const legacyName =
		`${project.repositoryOwner}/${project.repositoryName}`.toLowerCase();
	let legacy = connected.find(
		(c) => `${c.owner}/${c.repo}`.toLowerCase() === legacyName,
	);
	const parsed = deps.parseRepoUrl(project.repositoryUrl);
	if (!legacy) {
		legacy = {
			owner: project.repositoryOwner,
			repo: project.repositoryName,
			// Classified before any credential is looked up: a provider code
			// search cannot read stays unsupported whatever credential exists.
			// (A URL the shared parser cannot read names no provider code
			// search supports either.)
			status:
				parsed && isCodeSearchProvider(parsed.provider)
					? "unreadable"
					: "unsupported",
		};
		connected.push(legacy);
	}
	// Only an unreadable entry is worth a credential lookup: a readable one
	// already has its integration's credentials, and an unsupported one
	// (integration row or legacy) never becomes readable.
	if (legacy.status !== "unreadable" || !parsed) {
		return { readable: results, connected, legacyLookupFailed: false };
	}
	const legacyProvider: unknown = parsed.provider;
	if (!isCodeSearchProvider(legacyProvider)) {
		return { readable: results, connected, legacyLookupFailed: false };
	}

	// As for an integration row: a credential failure leaves this one
	// repository unreadable and keeps the ones already resolved.
	let token: string | null | undefined;
	try {
		token = await resolveLegacyToken(
			legacyProvider,
			userId,
			organizationId,
			deps,
		);
	} catch (error) {
		console.warn("[CodeSearchHandler] Legacy credential resolution threw", {
			repo: legacyName,
			errorClass: errorClassName(error),
		});
		token = undefined;
	}
	if (!token) {
		return { readable: results, connected, legacyLookupFailed: false };
	}
	legacy.status = "readable";
	results.push({
		provider: legacyProvider,
		token,
		owner: project.repositoryOwner,
		repo: project.repositoryName,
		branch: project.defaultBranch ?? undefined,
		azureProject:
			legacyProvider === "AZURE_DEVOPS"
				? adoProjectFromUrl(project.repositoryUrl)
				: undefined,
	});
	return { readable: results, connected, legacyLookupFailed: false };
}

/** The providers the code-search connectors can read. */
function isCodeSearchProvider(
	provider: unknown,
): provider is ResolvedParams["provider"] {
	return provider === "GITHUB" || provider === "AZURE_DEVOPS";
}

/** The Azure DevOps project segment of a repository URL, if any. */
function adoProjectFromUrl(url: string | null | undefined): string | undefined {
	return (
		url?.match(/dev\.azure\.com\/[^/]+\/([^/]+)\/_git\//i)?.[1] ??
		url?.match(/\.visualstudio\.com\/([^/]+)\/_git\//i)?.[1]
	);
}

/**
 * The credential for the legacy repository, from the same authority as
 * before: the caller's refresh-aware GitHub token, or for Azure DevOps the
 * caller's newest active WorkflowIntegration in this tenant.
 */
async function resolveLegacyToken(
	provider: ResolvedParams["provider"],
	userId: string,
	organizationId: string | undefined,
	deps: {
		db: any;
		decryptApiKey: (key: string) => string;
		getGitHubAccessToken: (
			userId: string,
			organizationId?: string,
		) => Promise<string | null>;
	},
): Promise<string | undefined> {
	// GitHub goes through the refresh-aware getter — the sibling Next.js route
	// that serves the same agent tool already did this, but this Temporal-side
	// copy raw-decrypted an 8h-lived token. Azure DevOps keeps the legacy
	// decrypt (a PAT, which does not expire).
	if (provider === "GITHUB") {
		return (
			(await deps.getGitHubAccessToken(userId, organizationId)) ??
			undefined
		);
	}
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };
	const integration = await deps.db.workflowIntegration.findFirst({
		where: {
			userId,
			...orgFilter,
			provider,
			NOT: { name: `${provider}_OAUTH_APP` },
			isActive: true,
		},
		select: { credentials: true },
		orderBy: { updatedAt: "desc" },
	});
	if (!integration?.credentials) {
		return undefined;
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
			return undefined;
		}
	}
	return (
		(creds.access_token as string) ||
		(creds.token as string) ||
		(creds.GITHUB_TOKEN as string) ||
		(creds.apiKey as string) ||
		undefined
	);
}
