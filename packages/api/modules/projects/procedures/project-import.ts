/**
 * Importing a project from its repository (specs/2026-10-23-repository-import):
 * start the analysis, follow its checklist, and apply what the person kept.
 *
 * `start` records a run and starts `projectImportWorkflow`, which reads the
 * whole repository and leaves its proposal on the run in REVIEW. `get`
 * returns the project's latest run for the checklist. `apply` hands the
 * person's selection to the waiting workflow, which creates it through
 * Fabric's existing create paths. Nothing here changes any other surface.
 *
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible +
 * PROJECT_READ to read, PROJECT_UPDATE to start or apply. The organization is
 * the project's own, resolved server-side.
 */
import { ORPCError } from "@orpc/client";
import {
	createProjectImportRun,
	db,
	getLatestProjectImportRun,
	getProjectImportRun,
	type ProjectImportFindings,
	type ProjectImportStep,
	updateProjectImportRun,
} from "@repo/database";
import { logger } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import {
	signalProjectImportApply,
	startProjectImportWorkflow,
} from "@repo/temporal/project-import-start";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../lib/audit";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import { projectNotFoundUnlessVisible } from "../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { requireHostingOrganizationId } from "./instructions/hosting-organization";

const destination = z.enum([
	"document",
	"context",
	"decision",
	"backlog",
	"knowledge",
	"skip",
]);

function view(run: Awaited<ReturnType<typeof getLatestProjectImportRun>>) {
	if (!run) {
		return { run: null };
	}
	return {
		run: {
			id: run.id,
			status: run.status,
			steps: run.steps as unknown as ProjectImportStep[],
			findings: (run.findings ?? null) as ProjectImportFindings | null,
			error: run.error,
			createdAt: run.createdAt.toISOString(),
			updatedAt: run.updatedAt.toISOString(),
		},
	};
}

export const startProjectImportProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/import",
		tags: ["Projects"],
		summary:
			"Analyse a connected repository and propose what Fabric should hold",
	})
	.input(
		z.object({
			projectId: z.string().min(1).max(128),
			organizationId: z.string().nullable().optional(),
			/** Omitted: the project's most recently connected repository. */
			repositoryIntegrationId: z.string().min(1).max(128).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const latest = await getLatestProjectImportRun(input.projectId);
		// Omitted: the repository the last import read, else the latest one
		// connected that is not the project's coding-instructions repository
		// (connected after the product repository, so "latest" alone would
		// import the instructions instead of the product).
		const instructionSync = input.repositoryIntegrationId
			? null
			: await db.projectInstructionRepositorySync.findUnique({
					where: { projectId: input.projectId },
					select: { repositoryIntegrationId: true },
				});
		const preferredId =
			input.repositoryIntegrationId ??
			(latest?.repositoryIntegrationId !==
			instructionSync?.repositoryIntegrationId
				? latest?.repositoryIntegrationId
				: undefined);
		const select = { id: true, provider: true } as const;
		const integration =
			(preferredId
				? await db.projectRepositoryIntegration.findFirst({
						where: { projectId: input.projectId, id: preferredId },
						select,
					})
				: null) ??
			(input.repositoryIntegrationId
				? null
				: await db.projectRepositoryIntegration.findFirst({
						where: {
							projectId: input.projectId,
							...(instructionSync
								? {
										id: {
											not: instructionSync.repositoryIntegrationId,
										},
									}
								: {}),
						},
						orderBy: { createdAt: "desc" },
						select,
					}));
		if (!integration) {
			throw new ORPCError("PRECONDITION_FAILED", {
				message: "Connect a repository to the project first.",
				data: { code: "NO_REPOSITORY" },
			});
		}
		if (
			latest &&
			(latest.status === "RUNNING" || latest.status === "APPLYING")
		) {
			throw new ORPCError("CONFLICT", {
				message: "An import is already running for this project.",
				data: { code: "IMPORT_RUNNING" },
			});
		}
		const run = await createProjectImportRun({
			projectId: input.projectId,
			userId: context.user.id,
			organizationId,
			repositoryIntegrationId: integration.id,
		});
		try {
			const client = await getTemporalClient();
			await startProjectImportWorkflow(
				client,
				{
					runId: run.id,
					projectId: input.projectId,
					organizationId,
					userId: context.user.id,
				},
				{ decorateStartOptions: withCorrelationMemo },
			);
		} catch (error) {
			logger.error("[projects.import] workflow start failed", {
				error: error instanceof Error ? error.name : typeof error,
			});
			await updateProjectImportRun(run.id, input.projectId, {
				status: "FAILED",
				error: "The import could not start. Try again.",
			});
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "The import could not start. Try again.",
			});
		}
		recordAuditFromRequest(context, {
			action: "project.import.started",
			category: "project",
			organizationId,
			projectId: input.projectId,
			resource: { type: "project", id: input.projectId, name: null },
			metadata: { provider: integration.provider },
		});
		return view(await getProjectImportRun(run.id, input.projectId));
	});

export const getProjectImportProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/import",
		tags: ["Projects"],
		summary:
			"The project's latest repository import: checklist and proposal",
	})
	.input(
		z.object({
			projectId: z.string().min(1).max(128),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) =>
		view(await getLatestProjectImportRun(input.projectId)),
	);

export const applyProjectImportProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/import/:runId/apply",
		tags: ["Projects"],
		summary:
			"Create in Fabric what the person kept from an import's proposal",
	})
	.input(
		z.object({
			projectId: z.string().min(1).max(128),
			organizationId: z.string().nullable().optional(),
			runId: z.string().min(1).max(128),
			selection: z.object({
				projectFields: z.object({
					description: z.boolean(),
					goals: z.boolean(),
					techStack: z.boolean(),
					features: z.boolean(),
				}),
				documents: z
					.array(
						z.object({
							path: z.string().min(1).max(1024),
							destination,
						}),
					)
					.max(5000),
			}),
		}),
	)
	.handler(async ({ input }) => {
		const run = await getProjectImportRun(input.runId, input.projectId);
		if (!run) {
			throw new ORPCError("NOT_FOUND", { message: "Import not found" });
		}
		if (run.status !== "REVIEW") {
			throw new ORPCError("CONFLICT", {
				message:
					run.status === "COMPLETED"
						? "This import was already applied."
						: "This import is not waiting for review.",
				data: { code: "IMPORT_NOT_IN_REVIEW" },
			});
		}
		try {
			const client = await getTemporalClient();
			await signalProjectImportApply(client, run.id, input.selection);
		} catch (error) {
			logger.warn("[projects.import] apply signal failed", {
				error: error instanceof Error ? error.name : typeof error,
			});
			throw new ORPCError("CONFLICT", {
				message:
					"This import is no longer waiting (it expired after a week). Start a new import.",
				data: { code: "IMPORT_EXPIRED" },
			});
		}
		await updateProjectImportRun(run.id, input.projectId, {
			status: "APPLYING",
		});
		return view(await getProjectImportRun(run.id, input.projectId));
	});
