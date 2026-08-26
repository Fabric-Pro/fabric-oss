/**
 * Fetch File Content from GitHub
 *
 * Procedure to fetch file content from a connected GitHub repository.
 * Used by the chat to resolve file:line references.
 */

import { ORPCError } from "@orpc/server";
import {
	fetchFileContent,
	getGitHubToken,
	parseGitHubRepoUrl,
} from "@repo/integrations/github";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const inputSchema = z.object({
	repositoryUrl: z.string().url(),
	filePath: z.string(),
	ref: z.string().optional(), // branch/tag/commit
});

export const fetchFileContentProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.INTEGRATION_READ))
	.route({
		method: "POST",
		path: "/github/fetch-file-content",
		summary: "Fetch file content from GitHub repository",
		description:
			"Fetches the content of a file from a connected GitHub repository. Used for resolving file:line references in chat.",
		tags: ["GitHub", "Code Intelligence"],
	})
	.input(inputSchema)
	.handler(async ({ input, context }) => {
		const { repositoryUrl, filePath, ref } = input;

		// Parse repository URL to get owner and repo
		const repoInfo = parseGitHubRepoUrl(repositoryUrl);
		if (!repoInfo) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Invalid GitHub repository URL",
			});
		}

		// Get GitHub token for the user/organization
		const token = await getGitHubToken({
			userId: context.user.id,
			organizationId: context.session.activeOrganizationId ?? undefined,
		});

		if (!token) {
			throw new ORPCError("UNAUTHORIZED", {
				message:
					"GitHub not connected. Please connect your GitHub account in settings.",
			});
		}

		try {
			const content = await fetchFileContent(token, {
				owner: repoInfo.owner,
				repo: repoInfo.repo,
				path: filePath,
				ref,
			});

			return {
				success: true,
				content: content.content,
				path: content.path,
				size: content.size,
				url: content.url,
			};
		} catch (error) {
			if (error instanceof Error) {
				if (error.message.includes("404")) {
					throw new ORPCError("NOT_FOUND", {
						message: `File not found: ${filePath}`,
					});
				}
				if (
					error.message.includes("401") ||
					error.message.includes("403")
				) {
					throw new ORPCError("FORBIDDEN", {
						message:
							"Access denied. Please check your GitHub permissions.",
					});
				}
			}
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to fetch file content",
			});
		}
	});
