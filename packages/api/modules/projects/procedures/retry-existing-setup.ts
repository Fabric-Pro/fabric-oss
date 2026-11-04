/**
 * Run a project's code analysis again
 *
 * The analysis of an imported project can fail; this starts it again over
 * the repositories the project is connected to, the same way
 * `existingSetup.start` does after an import (Fizzy #3429). Nothing of the
 * first run is replayed: the repositories and their roles are read from the
 * project as it is now.
 *
 * - Each connected repository is analysed for what it is to the project: the
 *   one its Coding Instructions sync reads is its instructions, the one its
 *   Living Memory sync reads is documentation (knowledge), every other one
 *   its code.
 * - No document is generated (the import generates none either).
 *
 * AUTHORIZATION: `requireProjectPermission(PROJECT_UPDATE)`, as `start`.
 */

import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { requireProjectOrganization } from "../lib/project-organization";
import { startExistingProjectSetup } from "./start-existing-setup";

type RepositoryRole = "code" | "instructions" | "knowledge";

export const retryExistingSetupProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/existing-setup/retry",
		tags: ["Projects"],
		summary: "Run the project's code analysis again",
	})
	.input(
		z.object({
			projectId: z.string(),
			// Accepted for client compatibility and ignored: the tenant is the
			// project's own organization.
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { projectId } = input;

		const project = await db.project.findUnique({
			where: { id: projectId },
			select: { id: true, name: true, organizationId: true },
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}
		// A project with no organization is refused before anything runs.
		requireProjectOrganization(project);

		const [integrations, instructionSync, contextSync] = await Promise.all([
			db.projectRepositoryIntegration.findMany({
				where: { projectId, status: { not: "DISCONNECTED" } },
				select: { id: true, repositoryUrl: true },
				orderBy: { createdAt: "asc" },
			}),
			db.projectInstructionRepositorySync.findUnique({
				where: { projectId },
				select: { repositoryIntegrationId: true },
			}),
			db.projectContextRepositorySync.findUnique({
				where: { projectId },
				select: { repositoryIntegrationId: true },
			}),
		]);

		const roleOf = (integrationId: string): RepositoryRole => {
			if (integrationId === instructionSync?.repositoryIntegrationId) {
				return "instructions";
			}
			if (integrationId === contextSync?.repositoryIntegrationId) {
				return "knowledge";
			}
			return "code";
		};

		const repoUrls: string[] = [];
		const repoRoles: Record<string, RepositoryRole> = {};
		for (const integration of integrations) {
			if (repoUrls.includes(integration.repositoryUrl)) {
				continue;
			}
			repoUrls.push(integration.repositoryUrl);
			repoRoles[integration.repositoryUrl] = roleOf(integration.id);
		}

		if (!Object.values(repoRoles).includes("code")) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"The project has no connected code repository to analyse",
			});
		}

		return startExistingProjectSetup({
			input: {
				projectId,
				repoUrls,
				repoRoles,
				selectedDocumentTypes: [],
				projectTypes: [],
				projectName: project.name,
			},
			user: context.user,
		});
	});
