import {
	db,
	isPmServerIdKeySentinel,
	readPmServerIdKeySentinel,
	resolvePMConfigForUser,
} from "@repo/database";
import { logger } from "@repo/logs";
import type { ContextItem } from "@repo/temporal";
import { pmServerKeyToDetectedType } from "@repo/utils";

/** Common structural comment shape (matches `PmComment` / `GitLabPMComment`). */
export interface PmCommentLike {
	author: string | null;
	createdAt: string | null;
	body: string;
}

/** Pure: map fetched comments to `PM_COMMENT` context items. */
export function pmCommentsToContextItems(
	comments: PmCommentLike[],
	opts: { toolLabel: string; linkOrId: string },
): ContextItem[] {
	return comments.map((c) => ({
		sourceLabel: `${opts.toolLabel} comment`,
		sourceType: "PM_COMMENT",
		sourceDate: c.createdAt ?? "",
		sourceLinkOrId: opts.linkOrId,
		content: c.author ? `From: ${c.author}\n${c.body}` : c.body,
	}));
}

const TOOL_LABELS: Record<string, string> = {
	"azure-devops": "Azure DevOps",
	fizzy: "Fizzy",
	gitlab: "GitLab",
	jira: "Jira",
	linear: "Linear",
	clickup: "ClickUp",
	trello: "Trello",
};

/**
 * Resolve the project's PM connection, fetch the linked ticket's comments, and
 * return them as `PM_COMMENT` context items. Supplemental + non-blocking:
 * returns `[]` on any miss (no link, no capability, fetch failure).
 */
export async function fetchStoryPmComments(args: {
	projectId: string;
	story: { externalId: string | null; externalUrl?: string | null };
	userId: string;
	organizationId?: string;
}): Promise<ContextItem[]> {
	const { projectId, story, userId } = args;
	const externalId = story.externalId;
	if (!externalId) {
		return [];
	}

	try {
		const project = await db.project.findUnique({
			where: { id: projectId },
			select: {
				organizationId: true,
				projectManagementMcpServerId: true,
				projectManagementMcpConfigId: true,
				projectManagementContainerId: true,
				projectManagementContainerName: true,
				projectManagementAdditionalContext: true,
			},
		});
		if (!project || !project.projectManagementContainerId) {
			return [];
		}

		const additionalContext =
			project.projectManagementAdditionalContext &&
			typeof project.projectManagementAdditionalContext === "object" &&
			!Array.isArray(project.projectManagementAdditionalContext)
				? (project.projectManagementAdditionalContext as Record<
						string,
						string
					>)
				: undefined;

		// Resolve the PM server key (sentinel → inline, catalog id → lookup) to
		// route GitLab (REST) vs the generic MCP path.
		let serverKey: string | null = null;
		const sid = project.projectManagementMcpServerId;
		if (sid) {
			serverKey = isPmServerIdKeySentinel(sid)
				? readPmServerIdKeySentinel(sid)
				: ((
						await db.mCPServer.findUnique({
							where: { id: sid },
							select: { key: true },
						})
					)?.key ?? null);
		}
		const detectedFromKey =
			pmServerKeyToDetectedType(serverKey) ?? undefined;
		const linkOrId = story.externalUrl ?? externalId;

		// GitLab: REST Notes path (no MCP comments tool, no RAG coverage).
		if (detectedFromKey === "gitlab") {
			const { resolveGitLabPMSource, getGitLabIssueNotesForPM } =
				await import("@repo/integrations/gitlab");
			const source = await resolveGitLabPMSource({
				userId,
				organizationId: project.organizationId,
				projectId,
			});
			if (!source) {
				return [];
			}
			const comments = await getGitLabIssueNotesForPM({
				source,
				gitlabProjectId: project.projectManagementContainerId,
				externalId,
				userId,
				organizationId: project.organizationId,
			});
			return pmCommentsToContextItems(comments, {
				toolLabel: TOOL_LABELS.gitlab,
				linkOrId,
			});
		}

		// Generic MCP path.
		const userMcpConfig = await resolvePMConfigForUser({
			configId: project.projectManagementMcpConfigId,
			mcpServerId: project.projectManagementMcpServerId,
			userId,
			organizationId: project.organizationId || undefined,
		});
		if (!userMcpConfig || !userMcpConfig.enabled) {
			return [];
		}

		const { discoverPMToolCapabilities, fetchPmComments } = await import(
			"@repo/temporal"
		);
		const capabilities = await discoverPMToolCapabilities({
			mcpConfigId: userMcpConfig.id,
			userId,
			organizationId: project.organizationId || undefined,
		});
		if (!capabilities?.taskComments) {
			return [];
		}

		const comments = await fetchPmComments({
			mcpConfigId: userMcpConfig.id,
			userId,
			organizationId: project.organizationId || undefined,
			capabilities,
			externalId,
			containerId: project.projectManagementContainerId,
			containerName: project.projectManagementContainerName ?? undefined,
			additionalContext,
		});

		const toolLabel =
			TOOL_LABELS[capabilities.detectedType ?? detectedFromKey ?? ""] ??
			"PM tool";
		return pmCommentsToContextItems(comments, { toolLabel, linkOrId });
	} catch (error) {
		logger.warn("[UpdateWithContext] PM comment fetch failed; skipping", {
			projectId,
			externalId,
			err: error instanceof Error ? error.message : String(error),
		});
		return [];
	}
}
