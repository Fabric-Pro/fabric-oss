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
	CodeSearchResult,
	CompareCommitsParams,
	CompareCommitsResult,
	CompareCommitsStatus,
	FileContentResult,
	GetFileParams,
	ListStructureParams,
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
export type {
	RepoAccessVerdict,
	RepoAccessVerdictFor,
} from "./repository-access-status";
export { integrationStatusForRepoAccess } from "./repository-access-status";
export { verifyRepositoryAccess } from "./repository-access";
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
// GitHub / GitLab PAT validation (request-path helpers)
export type { ValidateRepoPatResult } from "./repository-pat";
export { validateGitHubPat, validateGitLabPat } from "./repository-pat";
// Slack connector
export { SlackConnector } from "./slack";
// Federated connectors (auto-register on import)
export { SlackFederatedConnector } from "./slack/slack-federated";
// Types
export * from "./types";
