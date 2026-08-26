import { ORPCError } from "@orpc/client";
import { db, hasProjectAccess } from "@repo/database";
import {
	callMcpWithRestFallback,
	createGitLabRefreshFailureWriter,
	executeGitLabTool,
	getGitLabAccessToken,
	refreshMcpConfigToken,
	resolveGitLabSource,
} from "@repo/integrations/gitlab";
import { decryptApiKey } from "@repo/utils";
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
	"get_project",
	"list_merge_requests",
	"list_issues",
]);

/**
 * Execute a read-only GitLab tool for document context.
 *
 * Proxies executeGitLabTool with a whitelist of safe, read-only methods.
 * Used by the document editor to fetch code, MRs, and issues from the
 * project's connected GitLab repository.
 *
 * AUTHORIZATION: Uses hasProjectAccess() - verifies org membership + project access
 */
export const executeGitLabToolProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.DOCUMENT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/documents/gitlab-tool",
		tags: ["Projects", "Documents"],
		summary: "Execute a read-only GitLab tool for document context",
		description:
			"Execute a whitelisted GitLab tool to fetch code, MRs, or issues for AI-assisted document editing",
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

		const source = await resolveGitLabSource({
			userId: user.id,
			organizationId: organizationId ?? null,
			projectId: input.projectId,
			db: db as never,
			decrypt: decryptApiKey,
			refresh: (configId) =>
				refreshMcpConfigToken({ configId, db: db as never }),
			getRestToken: async ({ userId, organizationId: o }) =>
				(await getGitLabAccessToken(userId, o ?? undefined)) ?? null,
			// Without this the document editor degrades to REST on a dead
			// grant but persists nothing, so every subsequent request
			// refreshes the same revoked token again.
			markRefreshFailure: createGitLabRefreshFailureWriter(db as never),
		});

		if (!source) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"GitLab not connected. Please connect your GitLab account in Settings > Integrations.",
			});
		}

		try {
			const result = await callMcpWithRestFallback({
				source,
				method: input.methodName,
				args: input.args,
				restFallback: () =>
					executeGitLabTool(
						input.methodName,
						input.args,
						user.id,
						organizationId ?? undefined,
					),
			});

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
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `GitLab tool error: ${errorMessage}`,
			});
		}
	});
