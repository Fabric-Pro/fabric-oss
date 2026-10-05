/**
 * Connectors Package
 *
 * Provides connectors for external data sources (Slack, Notion, GitHub, etc.)
 * that sync data into Fabric for agent knowledge access.
 */

export type {
	AzureDevOpsRepo,
	AzureDevOpsRepoGroup,
	ListAzureDevOpsReposResult,
	ValidateAzureDevOpsPatResult,
} from "./azure-devops/discovery";
// Azure DevOps repo discovery + PAT validation (request-path helpers)
export {
	listAzureDevOpsProjectsAndRepos,
	validateAzureDevOpsPat,
} from "./azure-devops/discovery";
// Base connector
export {
	BaseConnector,
	getConnector,
	listConnectors,
	registerConnector,
} from "./base-connector";
export type {
	CodeSearchParams,
	CodeSearchResponse,
	CodeSearchResult,
	CompareCommitsParams,
	CompareCommitsResult,
	CompareCommitsStatus,
	FileContentResult,
	GetFileParams,
	ListStructureParams,
	RepositoryObjectType,
	RepositoryReadError,
	RepositoryStructure,
	SearchCodeParams,
	TreeEntry,
} from "./code-search";
// Code search (repository code search, file retrieval, structure listing, commit compare)
export {
	compareRepositoryCommits,
	getRepositoryFile,
	listRepositoryStructure,
	searchRepositoryCode,
} from "./code-search";
// Federated connector (real-time search)
export {
	FederatedConnector,
	getFederatedConnector,
	listFederatedConnectors,
	registerFederatedConnector,
	searchAllFederated,
} from "./federated-connector";
export { GitHubFederatedConnector } from "./github/github-federated";
// Repository access probe + outcome→status verdict (request-path helpers)
export type {
	RepoAccessOutcome,
	VerifyRepositoryAccessInput,
} from "./repository-access";
export { verifyRepositoryAccess } from "./repository-access";
export type {
	RepoAccessVerdict,
	RepoAccessVerdictFor,
} from "./repository-access-status";
export { integrationStatusForRepoAccess } from "./repository-access-status";
export type { RepositoryApiInput } from "./repository-api";
export type {
	ReadRepositoryBlobSizesInput,
	ReadRepositoryBlobSizesResult,
} from "./repository-blob-sizes";
export { readRepositoryBlobSizes } from "./repository-blob-sizes";
export type {
	BranchVerifyOutcome,
	ListRepositoryBranchesInput,
	ListRepositoryBranchesResult,
	RepositoryBranchRef,
	ResolveDefaultBranchInput,
	VerifyRepositoryBranchInput,
} from "./repository-branch";
// Remote branch verification + listing (request-path helpers)
export {
	listRepositoryBranches,
	parseAdoRepositoryUrl,
	resolveDefaultBranch,
	verifyRepositoryBranch,
} from "./repository-branch";
// Branch history within a folder (request-path helper)
export type {
	ListRepositoryCommitsInput,
	ListRepositoryCommitsResult,
	RepositoryCommit,
} from "./repository-commits";
export {
	COMMIT_MESSAGE_MAX_CHARS,
	COMMITS_PAGE_SIZE,
	listRepositoryCommits,
} from "./repository-commits";
// Commit-to-commit path diff and one file at a commit (request-path helpers)
export type {
	CompareRepositoryRefsInput,
	CompareRepositoryRefsResult,
	IsCommitOnBranchInput,
	IsCommitOnBranchResult,
	ReadRepositoryFileAtCommitInput,
	RepositoryCompareFile,
	RepositoryCompareStatus,
} from "./repository-compare";
export {
	compareRepositoryRefs,
	isCommitOnBranch,
	readRepositoryFileAtCommit,
} from "./repository-compare";
// Capped single-file read (request-path helper)
export type {
	ReadRepositoryFileInput,
	ReadRepositoryFileOutcome,
	ReadRepositoryFileResult,
} from "./repository-file";
export { readRepositoryFile } from "./repository-file";
// GitHub / GitLab PAT validation (request-path helpers)
export type { ValidateRepoPatResult } from "./repository-pat";
export { validateGitHubPat, validateGitLabPat } from "./repository-pat";
// Repository tree listing (request-path helper)
export type {
	ListRepositoryTreeInput,
	ListRepositoryTreeOutcome,
	ListRepositoryTreeResult,
	RepositoryTreeEntry,
} from "./repository-tree";
export {
	isRepositoryTreeProvider,
	listRepositoryTree,
	MAX_REPOSITORY_TREE_ENTRIES,
} from "./repository-tree";
// Slack connector
export { SlackConnector } from "./slack";
// Federated connectors (auto-register on import)
export { SlackFederatedConnector } from "./slack/slack-federated";
// Types
export * from "./types";
