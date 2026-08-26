import { ORPCError } from "@orpc/client";
import { hasProjectAccess } from "@repo/database";
import { executeGitHubTool } from "@repo/integrations/github";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/** Maximum characters for file content before truncation */
const MAX_FILE_CONTENT_LENGTH = 30_000;

/** Read-only methods allowed from the frontend */
const ALLOWED_METHODS = z.enum([
	"get_file_contents",
	"get_repository",
	"list_pull_requests",
	"list_issues",
]);

/**
 * Execute a read-only GitHub tool for document context.
 *
 * Proxies executeGitHubTool with a whitelist of safe, read-only methods.
 * Used by the document editor to fetch code, PRs, and issues from the
 * project's connected GitHub repository.
 *
 * AUTHORIZATION: Uses hasProjectAccess() - verifies org membership + project access
 */
export const executeGitHubToolProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.DOCUMENT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/documents/github-tool",
		tags: ["Projects", "Documents"],
		summary: "Execute a read-only GitHub tool for document context",
		description:
			"Execute a whitelisted GitHub tool to fetch code, PRs, or issues for AI-assisted document editing",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			methodName: ALLOWED_METHODS,
			args: z.record(z.string(), z.unknown()),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const hasAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		try {
			const result = await executeGitHubTool(
				input.methodName,
				input.args,
				user.id,
				organizationId ?? undefined,
			);

			// Truncate file content if too large
			if (
				input.methodName === "get_file_contents" &&
				result &&
				typeof result === "object" &&
				"content" in (result as Record<string, unknown>)
			) {
				const fileResult = result as Record<string, unknown>;
				const content = fileResult.content as string;
				if (content && content.length > MAX_FILE_CONTENT_LENGTH) {
					fileResult.content = `${content.substring(0, MAX_FILE_CONTENT_LENGTH)}\n\n[File truncated — ${content.length} characters total]`;
					fileResult.truncated = true;
				}
			}

			return { result };
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Unknown error";

			if (
				errorMessage.includes("GitHub") &&
				(errorMessage.includes("not connected") ||
					errorMessage.includes("not configured"))
			) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"GitHub not connected. Please connect your GitHub account in Settings > Integrations.",
				});
			}

			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `GitHub tool error: ${errorMessage}`,
			});
		}
	});
