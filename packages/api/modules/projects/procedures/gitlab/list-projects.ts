/**
 * List GitLab Projects (Grouped by Namespace)
 *
 * Uses resolveGitLabSource to pick the best credential source
 * (official MCP server, MCPConfig OAuth, or WorkflowIntegration REST token)
 * and then lists/groups the projects.
 */

import { db } from "@repo/database";
import {
	createGitLabRefreshFailureWriter,
	GitLabApiError,
	getAuthenticatedUser,
	getGitLabAccessToken,
	listUserProjects,
	refreshMcpConfigToken,
	resolveGitLabSource,
	searchGitLabProjects,
} from "@repo/integrations/gitlab";
import { decryptApiKey } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

// ============================================================================
// Types and helpers
// ============================================================================

interface GitLabProjectRaw {
	name: string;
	path_with_namespace: string;
	description: string | null;
	visibility: string;
	web_url: string;
	default_branch: string;
	last_activity_at: string;
	star_count: number;
	forked_from_project?: unknown;
	namespace: {
		full_path: string;
		path?: string;
		avatar_url?: string;
	};
}

interface RepoGroup {
	owner: string;
	ownerType: "user" | "org";
	repos: ReturnType<typeof transformProject>[];
}

interface ProjectsByOwnerEntry {
	ownerType: "user" | "org";
	/** Original-cased namespace as returned by GitLab (e.g. "Alice"). */
	displayName: string;
	projects: GitLabProjectRaw[];
}

function transformProject(project: GitLabProjectRaw) {
	return {
		name: project.path_with_namespace,
		fullName: project.path_with_namespace,
		description: project.description,
		isPrivate: project.visibility === "private",
		defaultBranch: project.default_branch,
		language: null as string | null,
		htmlUrl: project.web_url,
		updatedAt: project.last_activity_at,
		stars: project.star_count ?? 0,
		isFork: project.forked_from_project != null,
		owner:
			project.namespace?.full_path ??
			project.path_with_namespace?.split("/")[0] ??
			"",
	};
}

function groupProjects(
	projects: GitLabProjectRaw[],
	username: string,
): RepoGroup[] {
	const usernameLower = username.toLowerCase();
	// Keyed by lowercased namespace so that GitLab's mixed-case namespaces
	// (e.g. "Alice") collapse onto a single bucket regardless of how the
	// authenticated user's `username` is cased. The original-cased namespace
	// is preserved inside the entry for display.
	const projectsByOwner = new Map<string, ProjectsByOwnerEntry>();

	for (const project of projects) {
		// Use the top-level namespace path as the owner
		const namespacePath =
			project.namespace?.full_path ??
			project.path_with_namespace?.split("/")[0] ??
			"";
		if (!namespacePath) {
			continue;
		}

		// For nested groups (e.g. "group/subgroup/project"), use the top-level group
		const topLevelNamespace = namespacePath.split("/")[0];
		const topLevelNamespaceKey = topLevelNamespace.toLowerCase();

		if (!projectsByOwner.has(topLevelNamespaceKey)) {
			const isUser = topLevelNamespaceKey === usernameLower;
			projectsByOwner.set(topLevelNamespaceKey, {
				ownerType: isUser ? "user" : "org",
				displayName: topLevelNamespace,
				projects: [],
			});
		}
		projectsByOwner.get(topLevelNamespaceKey)?.projects.push(project);
	}

	const groups: RepoGroup[] = [];

	// User's own projects first
	const userGroup = projectsByOwner.get(usernameLower);
	if (userGroup && userGroup.projects.length > 0) {
		groups.push({
			owner: userGroup.displayName || username,
			ownerType: "user",
			repos: userGroup.projects.map(transformProject),
		});
	}

	// Group projects sorted alphabetically (by display name)
	const orgEntries = [...projectsByOwner.entries()]
		.filter(([key]) => key !== usernameLower)
		.sort((a, b) => a[1].displayName.localeCompare(b[1].displayName));

	for (const [, data] of orgEntries) {
		if (data.projects.length > 0) {
			groups.push({
				owner: data.displayName,
				ownerType: "org",
				repos: data.projects.map(transformProject),
			});
		}
	}

	return groups;
}

// ============================================================================
// Main Procedure
// ============================================================================

/**
 * AUTHORIZATION: Uses tenantProtectedProcedure (authenticated + tenant isolation)
 * Uses resolveGitLabSource to pick the best credential (official MCP, MCPConfig,
 * or WorkflowIntegration) and then lists GitLab projects.
 */
export const listGitLabProjectsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.INTEGRATION_READ))
	.route({
		method: "GET",
		path: "/projects/gitlab/repos",
		tags: ["Projects", "GitLab"],
		summary: "List GitLab projects, grouped by namespace",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			searchGroup: z.string().optional(),
			/** When provided, scopes the token lookup */
			projectId: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const source = await resolveGitLabSource({
			userId,
			organizationId: organizationId ?? null,
			projectId: input.projectId,
			db: db as never,
			decrypt: decryptApiKey,
			refresh: (configId) =>
				refreshMcpConfigToken({ configId, db: db as never }),
			getRestToken: async ({ userId: u, organizationId: o }) =>
				(await getGitLabAccessToken(u, o ?? undefined)) ?? null,
			// The project picker is polled by the UI, so an unrecorded dead
			// grant here refreshes the same revoked token on every render.
			markRefreshFailure: createGitLabRefreshFailureWriter(db as never),
		});

		if (!source) {
			return {
				configured: false,
				username: null as string | null,
				groups: [] as RepoGroup[],
				error: "GitLab not connected. Connect GitLab in Settings → Integrations or via the official GitLab MCP server.",
			};
		}

		try {
			if (source.kind === "official-mcp") {
				const searchGroup = input.searchGroup?.trim();
				const mcpArgs: Record<string, unknown> = {
					per_page: 100,
					order_by: "updated_at",
				};
				if (searchGroup) {
					mcpArgs.search = searchGroup;
				}
				const raw = (await source.callTool(
					"list_projects",
					mcpArgs,
				)) as GitLabProjectRaw[];

				if (searchGroup) {
					// Mirror the REST path: filter to projects whose top-level namespace
					// starts with the requested group name (case-insensitive). The MCP
					// search is fuzzy on title/description; this tightens it to a real
					// group-prefix match so the picker shows what the user expects.
					const filtered = raw.filter((p) => {
						const ns =
							p.namespace?.full_path ??
							p.path_with_namespace?.split("/")[0] ??
							"";
						return ns
							.toLowerCase()
							.startsWith(searchGroup.toLowerCase());
					});
					return {
						configured: true,
						username: null as string | null,
						groups:
							filtered.length > 0
								? [
										{
											owner: searchGroup,
											ownerType: "org" as const,
											repos: filtered.map(
												transformProject,
											),
										},
									]
								: [],
						error:
							filtered.length === 0
								? `No projects found for "${searchGroup}". Check the group name or your access.`
								: null,
					};
				}

				// username: null disables the "Your projects" / "(You)" affordance.
				// The official MCP list_projects payload doesn't reliably include the
				// authenticated user's namespace, and inferring it from raw[0] is wrong
				// (raw[0] could belong to any org the user has access to). The picker
				// gracefully renders without the user/org split when username is null.
				const groups = groupProjects(raw, "");
				return {
					configured: true,
					username: null as string | null,
					groups,
					error: null,
				};
			}

			// REST path
			const user = await getAuthenticatedUser(source.token);
			const username = user.login;

			if (input.searchGroup) {
				const groupName = input.searchGroup.trim();
				const groupSearchResults = await searchGitLabProjects(
					source.token,
					groupName,
					100,
				);
				const filtered = (
					groupSearchResults as unknown as GitLabProjectRaw[]
				).filter((p) => {
					const ns =
						p.namespace?.full_path ??
						p.path_with_namespace?.split("/")[0] ??
						"";
					return ns.toLowerCase().startsWith(groupName.toLowerCase());
				});
				return {
					configured: true,
					username,
					groups:
						filtered.length > 0
							? [
									{
										owner: groupName,
										ownerType: "org" as const,
										repos: filtered.map(transformProject),
									},
								]
							: [],
					error:
						filtered.length === 0
							? `No projects found for "${groupName}". Check the group name or your access.`
							: null,
				};
			}

			const allProjects = (await listUserProjects(
				source.token,
				100,
			)) as unknown as GitLabProjectRaw[];
			const groups = groupProjects(allProjects, username);
			return { configured: true, username, groups, error: null };
		} catch (err) {
			if (
				err instanceof GitLabApiError &&
				(err.status === 401 || err.status === 403)
			) {
				return {
					configured: true,
					username: null as string | null,
					groups: [] as RepoGroup[],
					error: `GitLab rejected the stored token (${err.status} ${err.message}). Reconnect in Settings → Integrations.`,
				};
			}
			return {
				configured: true,
				username: null as string | null,
				groups: [] as RepoGroup[],
				error:
					err instanceof Error
						? err.message
						: "Failed to list GitLab projects",
			};
		}
	});
