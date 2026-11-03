"use client";

import { useFrontendTool } from "@copilotkit/react-core";
import {
	githubGetFileContentsAction,
	githubGetRepositoryAction,
	githubListIssuesAction,
	githubListPullRequestsAction,
	gitlabGetFileContentsAction,
	gitlabGetProjectAction,
	gitlabListIssuesAction,
	gitlabListMergeRequestsAction,
} from "@repo/utils/editor-frontend-actions";
import { orpcClient } from "@shared/lib/orpc-client";
import { Loader2 } from "lucide-react";

interface RepositoryFrontendToolsProps {
	projectId: string;
	organizationId: string | null;
	/** The project has a GitHub repository. */
	hasGitHub: boolean;
	/** The project has a GitLab repository. */
	hasGitLab: boolean;
	repoOwner: string | undefined;
	repoName: string | undefined;
	/** Undefined when the project has not recorded its default branch. */
	repoBranch: string | undefined;
	/** The URL-encoded `owner/repo` path for a GitLab repository, else "". */
	gitlabProjectId: string;
}

/**
 * Registers the repository tools of the document assistant and renders
 * nothing.
 *
 * These tools let the AI assistant read code, PRs, and issues from the
 * project's connected GitHub or GitLab repository. Follows the
 * fetchMeetingNotes pattern. Auto-fills owner/repo from project settings so
 * the user only needs to specify paths. The definitions are shared with the
 * agent (`editor-frontend-actions`).
 *
 * Offered only while the project has that provider's repository:
 * CopilotKit sends a tool registered `available: "disabled"` to no agent,
 * and registers it again when `available` changes (the project loads, or
 * a repository is connected while the page is open). `useFrontendTool`,
 * not `useCopilotAction`: the latter turns a disabled action into a
 * render-only one, and throws when that kind changes between renders.
 * The handlers still refuse without a repository.
 *
 * CopilotKit registers a tool again only when its name or `available`
 * changes, never for a new description, so the editor mounts this
 * component keyed by `owner/repo`: another repository remounts it, and the
 * tools are registered again with descriptions that name that repository.
 * Handlers and renders read the latest props without a remount.
 */
export function RepositoryFrontendTools({
	projectId,
	organizationId,
	hasGitHub,
	hasGitLab,
	repoOwner,
	repoName,
	repoBranch,
	gitlabProjectId,
}: RepositoryFrontendToolsProps) {
	const repository = `${repoOwner}/${repoName}`;
	const githubFileContents = githubGetFileContentsAction(repository);
	const githubRepository = githubGetRepositoryAction(repository);
	const githubPullRequests = githubListPullRequestsAction(repository);
	const githubIssues = githubListIssuesAction(repository);
	const gitlabFileContents = gitlabGetFileContentsAction(repository);
	const gitlabProject = gitlabGetProjectAction(repository);
	const gitlabMergeRequests = gitlabListMergeRequestsAction(repository);
	const gitlabIssues = gitlabListIssuesAction(repository);

	useFrontendTool(
		{
			name: githubFileContents.name,
			description: githubFileContents.description,
			available: hasGitHub ? "enabled" : "disabled",
			parameters: githubFileContents.parameters,
			handler: async (args) => {
				if (!hasGitHub) {
					return "GitHub not connected to this project.";
				}
				try {
					const result =
						await orpcClient.projects.documents.executeGitHubTool({
							projectId,
							organizationId: organizationId ?? null,
							methodName: "get_file_contents",
							args: {
								owner: repoOwner,
								repo: repoName,
								path: args.path,
								ref: (args.ref as string) || repoBranch,
							},
						});
					const data = result.result as Record<string, unknown>;
					if (Array.isArray(data)) {
						const listing = (data as Array<Record<string, unknown>>)
							.map(
								(f) =>
									`${f.type === "dir" ? "dir" : "file"}  ${f.path}`,
							)
							.join("\n");
						return `DIRECTORY LISTING: ${args.path}\n\n${listing}`;
					}
					const content = (data.content as string) || "";
					const filePath = (data.path as string) || args.path;
					return `FILE: ${filePath}\n\n\`\`\`\n${content}\n\`\`\``;
				} catch (error) {
					return `Error reading file: ${error instanceof Error ? error.message : "Unknown error"}`;
				}
			},
			render: ({ status }) => {
				if (status === "complete") {
					return (
						<div className="p-3 rounded-lg bg-green-50 dark:bg-green-950/30 text-sm">
							File contents fetched from GitHub.
						</div>
					);
				}
				return (
					<div className="p-3 rounded-lg bg-muted/50 flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
						Reading from GitHub repository...
					</div>
				);
			},
		},
		[hasGitHub, repoOwner, repoName, repoBranch],
	);

	useFrontendTool(
		{
			name: githubRepository.name,
			description: githubRepository.description,
			available: hasGitHub ? "enabled" : "disabled",
			parameters: githubRepository.parameters,
			handler: async () => {
				if (!hasGitHub) {
					return "GitHub not connected to this project.";
				}
				try {
					const result =
						await orpcClient.projects.documents.executeGitHubTool({
							projectId,
							organizationId: organizationId ?? null,
							methodName: "get_repository",
							args: { owner: repoOwner, repo: repoName },
						});
					const repo = result.result as Record<string, unknown>;
					return [
						`REPOSITORY: ${repo.full_name || `${repoOwner}/${repoName}`}`,
						`Description: ${repo.description || "N/A"}`,
						`Language: ${repo.language || "N/A"}`,
						`Default branch: ${repo.default_branch || repoBranch || "unknown"}`,
						`Topics: ${(repo.topics as string[])?.join(", ") || "none"}`,
						`Last updated: ${repo.updated_at || "N/A"}`,
					].join("\n");
				} catch (error) {
					return `Error fetching repository info: ${error instanceof Error ? error.message : "Unknown error"}`;
				}
			},
			render: ({ status }) => {
				if (status === "complete") {
					return (
						<div className="p-3 rounded-lg bg-green-50 dark:bg-green-950/30 text-sm">
							Repository info fetched.
						</div>
					);
				}
				return (
					<div className="p-3 rounded-lg bg-muted/50 flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
						Fetching repository info...
					</div>
				);
			},
		},
		[hasGitHub, repoOwner, repoName],
	);

	useFrontendTool(
		{
			name: githubPullRequests.name,
			description: githubPullRequests.description,
			available: hasGitHub ? "enabled" : "disabled",
			parameters: githubPullRequests.parameters,
			handler: async (args) => {
				if (!hasGitHub) {
					return "GitHub not connected to this project.";
				}
				try {
					const result =
						await orpcClient.projects.documents.executeGitHubTool({
							projectId,
							organizationId: organizationId ?? null,
							methodName: "list_pull_requests",
							args: {
								owner: repoOwner,
								repo: repoName,
								state: (args.state as string) || "open",
								per_page: 15,
							},
						});
					const prs = result.result as Array<Record<string, unknown>>;
					if (!Array.isArray(prs) || prs.length === 0) {
						return "No pull requests found.";
					}
					const formatted = prs
						.map(
							(pr) =>
								`- #${pr.number} ${pr.title} (${pr.state}${pr.draft ? ", draft" : ""}) by ${pr.author || "unknown"} — ${pr.head} → ${pr.base}`,
						)
						.join("\n");
					return `PULL REQUESTS (${(args.state as string) || "open"}):\n\n${formatted}`;
				} catch (error) {
					return `Error fetching pull requests: ${error instanceof Error ? error.message : "Unknown error"}`;
				}
			},
			render: ({ status }) => {
				if (status === "complete") {
					return (
						<div className="p-3 rounded-lg bg-green-50 dark:bg-green-950/30 text-sm">
							Pull requests fetched from GitHub.
						</div>
					);
				}
				return (
					<div className="p-3 rounded-lg bg-muted/50 flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
						Fetching pull requests...
					</div>
				);
			},
		},
		[hasGitHub, repoOwner, repoName],
	);

	useFrontendTool(
		{
			name: githubIssues.name,
			description: githubIssues.description,
			available: hasGitHub ? "enabled" : "disabled",
			parameters: githubIssues.parameters,
			handler: async (args) => {
				if (!hasGitHub) {
					return "GitHub not connected to this project.";
				}
				try {
					const result =
						await orpcClient.projects.documents.executeGitHubTool({
							projectId,
							organizationId: organizationId ?? null,
							methodName: "list_issues",
							args: {
								owner: repoOwner,
								repo: repoName,
								state: (args.state as string) || "open",
								per_page: 15,
							},
						});
					const issues = result.result as Array<
						Record<string, unknown>
					>;
					if (!Array.isArray(issues) || issues.length === 0) {
						return "No issues found.";
					}
					const formatted = issues
						.map(
							(i) =>
								`- #${i.number} ${i.title} (${i.state}) [${(i.labels as string[])?.join(", ") || "no labels"}]`,
						)
						.join("\n");
					return `ISSUES (${(args.state as string) || "open"}):\n\n${formatted}`;
				} catch (error) {
					return `Error fetching issues: ${error instanceof Error ? error.message : "Unknown error"}`;
				}
			},
			render: ({ status }) => {
				if (status === "complete") {
					return (
						<div className="p-3 rounded-lg bg-green-50 dark:bg-green-950/30 text-sm">
							Issues fetched from GitHub.
						</div>
					);
				}
				return (
					<div className="p-3 rounded-lg bg-muted/50 flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
						Fetching issues...
					</div>
				);
			},
		},
		[hasGitHub, repoOwner, repoName],
	);

	// ── GitLab CopilotKit actions ───────────────────────────────────
	// Mirror the GitHub actions above but target GitLab API via executeGitLabTool

	useFrontendTool(
		{
			name: gitlabFileContents.name,
			description: gitlabFileContents.description,
			available: hasGitLab ? "enabled" : "disabled",
			parameters: gitlabFileContents.parameters,
			handler: async (args) => {
				if (!hasGitLab) {
					return "GitLab not connected to this project.";
				}
				try {
					const result =
						await orpcClient.projects.documents.executeGitLabTool({
							projectId,
							organizationId: organizationId ?? null,
							methodName: "get_file_contents",
							args: {
								project_id: gitlabProjectId,
								path: args.path,
								ref:
									(args.ref as string) ||
									repoBranch ||
									"HEAD",
							},
						});
					const data = result.result as Record<string, unknown>;
					if (Array.isArray(data)) {
						const listing = (data as Array<Record<string, unknown>>)
							.map(
								(f) =>
									`${f.type === "tree" ? "dir" : "file"}  ${f.path}`,
							)
							.join("\n");
						return `DIRECTORY LISTING: ${args.path}\n\n${listing}`;
					}
					const content = (data.content as string) || "";
					const filePath = (data.path as string) || args.path;
					return `FILE: ${filePath}\n\n\`\`\`\n${content}\n\`\`\``;
				} catch (error) {
					return `Error reading file: ${error instanceof Error ? error.message : "Unknown error"}`;
				}
			},
			render: ({ status }) => {
				if (status === "complete") {
					return (
						<div className="p-3 rounded-lg bg-green-50 dark:bg-green-950/30 text-sm">
							File contents fetched from GitLab.
						</div>
					);
				}
				return (
					<div className="p-3 rounded-lg bg-muted/50 flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
						Reading from GitLab repository...
					</div>
				);
			},
		},
		[hasGitLab, repoOwner, repoName, repoBranch, gitlabProjectId],
	);

	useFrontendTool(
		{
			name: gitlabProject.name,
			description: gitlabProject.description,
			available: hasGitLab ? "enabled" : "disabled",
			parameters: gitlabProject.parameters,
			handler: async () => {
				if (!hasGitLab) {
					return "GitLab not connected to this project.";
				}
				try {
					const result =
						await orpcClient.projects.documents.executeGitLabTool({
							projectId,
							organizationId: organizationId ?? null,
							methodName: "get_project",
							args: { project_id: gitlabProjectId },
						});
					const proj = result.result as Record<string, unknown>;
					return [
						`PROJECT: ${proj.name_with_namespace || `${repoOwner}/${repoName}`}`,
						`Description: ${proj.description || "N/A"}`,
						`Default branch: ${proj.default_branch || repoBranch || "unknown"}`,
						`Topics: ${(proj.topics as string[])?.join(", ") || "none"}`,
						`Last activity: ${proj.last_activity_at || "N/A"}`,
					].join("\n");
				} catch (error) {
					return `Error fetching project info: ${error instanceof Error ? error.message : "Unknown error"}`;
				}
			},
			render: ({ status }) => {
				if (status === "complete") {
					return (
						<div className="p-3 rounded-lg bg-green-50 dark:bg-green-950/30 text-sm">
							Project info fetched from GitLab.
						</div>
					);
				}
				return (
					<div className="p-3 rounded-lg bg-muted/50 flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
						Fetching project info...
					</div>
				);
			},
		},
		[hasGitLab, repoOwner, repoName, gitlabProjectId],
	);

	useFrontendTool(
		{
			name: gitlabMergeRequests.name,
			description: gitlabMergeRequests.description,
			available: hasGitLab ? "enabled" : "disabled",
			parameters: gitlabMergeRequests.parameters,
			handler: async (args) => {
				if (!hasGitLab) {
					return "GitLab not connected to this project.";
				}
				try {
					const result =
						await orpcClient.projects.documents.executeGitLabTool({
							projectId,
							organizationId: organizationId ?? null,
							methodName: "list_merge_requests",
							args: {
								project_id: gitlabProjectId,
								state: (args.state as string) || "opened",
								per_page: 15,
							},
						});
					const mrs = result.result as Array<Record<string, unknown>>;
					if (!Array.isArray(mrs) || mrs.length === 0) {
						return "No merge requests found.";
					}
					const formatted = mrs
						.map(
							(mr) =>
								`- !${mr.iid} ${mr.title} (${mr.state}${mr.draft ? ", draft" : ""}) by ${mr.author || "unknown"} -- ${mr.source_branch} -> ${mr.target_branch}`,
						)
						.join("\n");
					return `MERGE REQUESTS (${(args.state as string) || "opened"}):\n\n${formatted}`;
				} catch (error) {
					return `Error fetching merge requests: ${error instanceof Error ? error.message : "Unknown error"}`;
				}
			},
			render: ({ status }) => {
				if (status === "complete") {
					return (
						<div className="p-3 rounded-lg bg-green-50 dark:bg-green-950/30 text-sm">
							Merge requests fetched from GitLab.
						</div>
					);
				}
				return (
					<div className="p-3 rounded-lg bg-muted/50 flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
						Fetching merge requests...
					</div>
				);
			},
		},
		[hasGitLab, repoOwner, repoName, gitlabProjectId],
	);

	useFrontendTool(
		{
			name: gitlabIssues.name,
			description: gitlabIssues.description,
			available: hasGitLab ? "enabled" : "disabled",
			parameters: gitlabIssues.parameters,
			handler: async (args) => {
				if (!hasGitLab) {
					return "GitLab not connected to this project.";
				}
				try {
					const result =
						await orpcClient.projects.documents.executeGitLabTool({
							projectId,
							organizationId: organizationId ?? null,
							methodName: "list_issues",
							args: {
								project_id: gitlabProjectId,
								state: (args.state as string) || "opened",
								per_page: 15,
							},
						});
					const issues = result.result as Array<
						Record<string, unknown>
					>;
					if (!Array.isArray(issues) || issues.length === 0) {
						return "No issues found.";
					}
					const formatted = issues
						.map(
							(i) =>
								`- #${i.iid} ${i.title} (${i.state}) [${(i.labels as string[])?.join(", ") || "no labels"}]`,
						)
						.join("\n");
					return `ISSUES (${(args.state as string) || "opened"}):\n\n${formatted}`;
				} catch (error) {
					return `Error fetching issues: ${error instanceof Error ? error.message : "Unknown error"}`;
				}
			},
			render: ({ status }) => {
				if (status === "complete") {
					return (
						<div className="p-3 rounded-lg bg-green-50 dark:bg-green-950/30 text-sm">
							Issues fetched from GitLab.
						</div>
					);
				}
				return (
					<div className="p-3 rounded-lg bg-muted/50 flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
						Fetching issues...
					</div>
				);
			},
		},
		[hasGitLab, repoOwner, repoName, gitlabProjectId],
	);

	return null;
}
