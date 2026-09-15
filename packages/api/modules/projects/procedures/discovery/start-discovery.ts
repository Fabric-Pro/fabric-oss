/**
 * Start Discovery Run (plan Slice 4)
 *
 * AUTHORIZATION: requireProjectPermission(AGENT_EXECUTE).
 *
 * Preconditions:
 *   - the feature is on the DISCOVERY track (PRECONDITION_FAILED otherwise)
 *   - an OpenAPI context must belong to the project AND the caller's tenant
 *     (XOR via `getContextById`; foreign ids are NOT_FOUND)
 *   - every MCP config must belong to the caller within the project's
 *     context (XOR via `getMcpConfigById`; foreign ids are NOT_FOUND)
 *   - an OpenAPI URL must pass the literal SSRF check here; the DNS-pinned
 *     check runs again in the activity at fetch time
 *
 * One active run per feature is enforced by the partial unique index
 * `discovery_run_one_active_per_story` (P2002 → CONFLICT). The workflow id
 * is deterministic (`discovery-run-${id}`); on a generic start error the
 * id is described before the row is released, mirroring coding-run start.
 */

import { ORPCError } from "@orpc/client";
import { db, getContextById, getMcpConfigById } from "@repo/database";
import { logger } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import { getUnsafeUrlReason } from "@repo/utils/url-security";
import { z } from "zod";
import { isUniqueConstraintViolation } from "../../../../lib/prisma-unique-violation";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	ACTIVE_DISCOVERY_RUN_CONFLICT_MESSAGE,
	ACTIVE_DISCOVERY_RUN_INDEX,
	discoveryRunWorkflowId,
	discoverySourcesSchema,
	isWorkflowAlreadyStartedError,
	isWorkflowNotFoundError,
} from "./lib";

type TemporalClient = Awaited<ReturnType<typeof getTemporalClient>>;

type WorkflowStartOutcome =
	| { status: "exists" }
	| { status: "not-found" }
	| { status: "unknown"; error: unknown };

async function describeWorkflowStart(
	client: TemporalClient,
	workflowId: string,
): Promise<WorkflowStartOutcome> {
	try {
		await client.workflow.getHandle(workflowId).describe();
		return { status: "exists" };
	} catch (error) {
		if (isWorkflowNotFoundError(error)) {
			return { status: "not-found" };
		}
		return { status: "unknown", error };
	}
}

function toStartError(error: unknown): ORPCError<string, unknown> {
	if (error instanceof ORPCError) {
		return error;
	}
	return new ORPCError("INTERNAL_SERVER_ERROR", {
		message: `Failed to start discovery run: ${error instanceof Error ? error.message : "Unknown error"}`,
	});
}

export const startDiscoveryProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.AGENT_EXECUTE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/discovery/start",
		tags: ["Projects", "Features", "Discovery"],
		summary: "Start a discovery run for a DISCOVERY-track feature",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
			sources: discoverySourcesSchema,
		}),
	)
	.output(
		z.object({
			discoveryRunId: z.string(),
			workflowId: z.string(),
			status: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;
		const { projectId, storyId, sources } = input;

		const story = await db.userStory.findFirst({
			where: { id: storyId, projectId },
			select: {
				id: true,
				identifier: true,
				title: true,
				deliveryTrack: true,
				project: {
					select: {
						name: true,
						description: true,
						techStack: true,
						organizationId: true,
						repositoryUrl: true,
					},
				},
			},
		});
		if (!story) {
			throw new ORPCError("NOT_FOUND", { message: "Feature not found" });
		}

		if (story.deliveryTrack !== "DISCOVERY") {
			throw new ORPCError("PRECONDITION_FAILED", {
				message:
					"Discovery runs are only available for features on the Discovery track.",
				data: {
					code: "NOT_DISCOVERY_TRACK",
					track: story.deliveryTrack,
				},
			});
		}

		// Project is the source of truth for tenant scope (never the session
		// org, which would mis-scope a personal project run).
		const workflowOrgId = story.project.organizationId ?? undefined;

		if (
			!sources.repo &&
			!sources.openApi &&
			!sources.mcpConfigIds?.length
		) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Select at least one evidence source.",
			});
		}

		if (sources.repo && !story.project.repositoryUrl) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Connect a repository to the project before using it as a discovery source.",
			});
		}

		if (sources.openApi) {
			if ("contextId" in sources.openApi) {
				const projectContext = await getContextById(
					sources.openApi.contextId,
					projectId,
					{ userId: user.id, organizationId: workflowOrgId ?? null },
				);
				if (!projectContext || projectContext.projectId !== projectId) {
					throw new ORPCError("NOT_FOUND", {
						message: "OpenAPI context not found in this project",
					});
				}
				if (projectContext.extractionStatus === "FAILED") {
					throw new ORPCError("BAD_REQUEST", {
						message:
							"Text extraction failed for this document. Re-upload it before running discovery.",
					});
				}
			} else {
				const reason = getUnsafeUrlReason(sources.openApi.url);
				if (reason) {
					throw new ORPCError("BAD_REQUEST", {
						message: `OpenAPI URL rejected: ${reason}`,
					});
				}
			}
		}

		if (sources.mcpConfigIds && sources.mcpConfigIds.length > 0) {
			const unique = Array.from(new Set(sources.mcpConfigIds));
			for (const configId of unique) {
				// XOR: the caller's own config within the project's context.
				const config = await getMcpConfigById(configId, {
					userId: user.id,
					organizationId: workflowOrgId,
				});
				if (!config) {
					throw new ORPCError("NOT_FOUND", {
						message: "MCP server configuration not found",
						data: { code: "MCP_CONFIG_NOT_FOUND", configId },
					});
				}
			}
			sources.mcpConfigIds = unique;
		}

		let run: { id: string };
		try {
			run = await db.discoveryRun.create({
				data: {
					projectId,
					storyId,
					userId: user.id,
					organizationId: workflowOrgId,
					status: "QUEUED",
					sources,
				},
				select: { id: true },
			});
		} catch (error) {
			if (
				isUniqueConstraintViolation(error, ACTIVE_DISCOVERY_RUN_INDEX)
			) {
				throw new ORPCError("CONFLICT", {
					message: ACTIVE_DISCOVERY_RUN_CONFLICT_MESSAGE,
					data: { code: "ACTIVE_RUN_EXISTS", storyId },
				});
			}
			throw error;
		}

		const workflowId = discoveryRunWorkflowId(run.id);

		/** Releases the QUEUED row. Only valid while no execution exists. */
		const releaseQueuedRow = async (message: string) => {
			await db.discoveryRun
				.update({
					where: { id: run.id },
					data: { status: "FAILED", error: message },
				})
				.catch(() => {});
		};

		let temporal: TemporalClient;
		try {
			temporal = await getTemporalClient();
		} catch (error) {
			await releaseQueuedRow(
				error instanceof Error ? error.message : "Temporal unavailable",
			);
			throw toStartError(error);
		}

		try {
			await temporal.workflow.start("discoveryRunWorkflow", {
				taskQueue: "project-documents",
				workflowId,
				args: [
					{
						discoveryRunId: run.id,
						projectId,
						storyId,
						userId: user.id,
						organizationId: workflowOrgId,
						sources,
						story: {
							identifier: story.identifier,
							title: story.title,
						},
						project: {
							name: story.project.name,
							description: story.project.description,
							techStack: story.project.techStack,
						},
					},
				],
			});
		} catch (error) {
			if (isWorkflowAlreadyStartedError(error)) {
				logger.info(
					{ discoveryRunId: run.id, workflowId },
					"[Discovery] Workflow already started; treating start as confirmed",
				);
			} else {
				const outcome = await describeWorkflowStart(
					temporal,
					workflowId,
				);
				if (outcome.status === "not-found") {
					await releaseQueuedRow(
						error instanceof Error
							? error.message
							: "Workflow start failed",
					);
					throw toStartError(error);
				}
				if (outcome.status === "unknown") {
					logger.warn(
						{
							err: error,
							describeErr: outcome.error,
							discoveryRunId: run.id,
							workflowId,
						},
						"[Discovery] Workflow start outcome unknown; leaving row active",
					);
					throw new ORPCError("INTERNAL_SERVER_ERROR", {
						message: `Could not confirm whether the discovery workflow started (${error instanceof Error ? error.message : "Unknown error"}). The run remains active; retry once Temporal is reachable or cancel it.`,
					});
				}
				logger.info(
					{ err: error, discoveryRunId: run.id, workflowId },
					"[Discovery] Start rejected but the workflow exists; treating start as confirmed",
				);
			}
		}

		// Bookkeeping for a running workflow: never changes the row status.
		await db.discoveryRun
			.update({ where: { id: run.id }, data: { workflowId } })
			.catch((error) => {
				logger.warn(
					{ err: error, discoveryRunId: run.id, workflowId },
					"[Discovery] Workflow started but post-start bookkeeping failed",
				);
			});

		return { discoveryRunId: run.id, workflowId, status: "started" };
	});
