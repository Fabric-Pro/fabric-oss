/**
 * The organization's GitLab project repository links, for the GitLab
 * provider page.
 *
 * A repository link (`ProjectRepositoryIntegration`) is a team grant on one
 * project, with its own token. It is not the person's GitLab connection: a
 * personal disconnect never touches it, and it never makes a person
 * "connected". The provider page lists the links next to the person's own
 * connection so both are visible in one place, each with its own disconnect.
 *
 * Listing is object-level: a link is returned only when the caller can see
 * its project (`hasProjectAccess`). `canDisconnect` mirrors the check the
 * existing per-project disconnect route enforces —
 * `requireProjectPermission(PROJECT_SETTINGS_EDIT)`, which
 * `canEditProjectSettings` evaluates the same way — so the page offers the
 * button only to callers that route will accept. The route itself is
 * unchanged and stays the authority.
 *
 * No token, error text or other credential field leaves this procedure.
 */

import { ORPCError } from "@orpc/server";
import { canEditProjectSettings, db, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const repositoryLinkSchema = z.object({
	id: z.string(),
	projectId: z.string(),
	projectName: z.string(),
	repositoryOwner: z.string(),
	repositoryName: z.string(),
	repositoryUrl: z.string(),
	authMethod: z.string(),
	status: z.string(),
	canDisconnect: z.boolean(),
});

type GitLabRepositoryLink = z.infer<typeof repositoryLinkSchema>;

export const listGitLabRepositoryLinksProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.INTEGRATION_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "GET",
		path: "/integrations/gitlab/repository-links",
		tags: ["Integrations", "GitLab"],
		summary:
			"List the organization's GitLab project repository links the caller can see",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(z.object({ links: z.array(repositoryLinkSchema) }))
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		// `requireOrganization: true` above already refuses this, with the
		// marked missing-organization error; this only narrows the type.
		if (!organizationId) {
			throw new ORPCError("FORBIDDEN", {
				message: "An organization is required",
			});
		}

		const rows = await db.projectRepositoryIntegration.findMany({
			where: { provider: "GITLAB", project: { organizationId } },
			select: {
				id: true,
				projectId: true,
				repositoryOwner: true,
				repositoryName: true,
				repositoryUrl: true,
				authMethod: true,
				status: true,
				project: { select: { name: true } },
			},
			orderBy: [{ createdAt: "asc" }, { id: "asc" }],
		});

		// One access decision per project, not per link.
		const projectIds = [...new Set(rows.map((row) => row.projectId))];
		const access = new Map<
			string,
			{ visible: boolean; canDisconnect: boolean }
		>();
		await Promise.all(
			projectIds.map(async (projectId) => {
				const visible = await hasProjectAccess(projectId, userId);
				const canDisconnect = visible
					? await canEditProjectSettings(projectId, userId)
					: false;
				access.set(projectId, { visible, canDisconnect });
			}),
		);

		const links: GitLabRepositoryLink[] = [];
		for (const row of rows) {
			const decision = access.get(row.projectId);
			if (!decision?.visible) {
				continue;
			}
			links.push({
				id: row.id,
				projectId: row.projectId,
				projectName: row.project?.name ?? "Untitled project",
				repositoryOwner: row.repositoryOwner,
				repositoryName: row.repositoryName,
				repositoryUrl: row.repositoryUrl,
				authMethod: String(row.authMethod),
				status: String(row.status),
				canDisconnect: decision.canDisconnect,
			});
		}
		return { links };
	});
