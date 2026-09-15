/**
 * Accept Spike Procedure (plan Slice 3)
 *
 * AUTHORIZATION: project-level AGENT_EXECUTE via requireProjectPermission
 * (the input carries projectId). The run is then loaded within that
 * project and the project's tenant (XOR) — a run from another project or
 * tenant is NOT_FOUND.
 *
 * Applies the spike findings to the story (description append +
 * FeatureVersion), records play notes, sets the run COMPLETED — the
 * status the readiness evidence provider counts — and optionally sets the
 * next delivery track. The transaction lives in `@repo/database`
 * (`applySpikeFindings`) so this module does not import Temporal.
 */

import { ORPCError } from "@orpc/client";
import {
	addCodingRunEvent,
	applySpikeFindings,
	db,
	SpikeRunNotFoundError,
	SpikeRunStateError,
} from "@repo/database";
import { logger, logWorkflowEvent } from "@repo/logs";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const spikeNextTrackSchema = z.enum(["SPIKE", "DISCOVERY", "SPECIFY", "DEFER"]);

const stageTransitionOutcomeSchema = z.discriminatedUnion("outcome", [
	z.object({ outcome: z.literal("applied"), toStage: z.string() }),
	z.object({ outcome: z.literal("requested"), requestId: z.string() }),
	z.object({ outcome: z.literal("skipped"), reason: z.string() }),
	z.object({ outcome: z.literal("blocked"), reason: z.string() }),
]);

/** Map the database's spike errors onto oRPC codes. */
export function mapSpikeRunError(error: unknown): unknown {
	if (error instanceof SpikeRunNotFoundError) {
		return new ORPCError("NOT_FOUND", { message: error.message });
	}
	if (error instanceof SpikeRunStateError) {
		return new ORPCError("CONFLICT", {
			message: error.message,
			data: {
				code: "SPIKE_NOT_DEMO_READY",
				status: error.status,
				kind: error.kind,
			},
		});
	}
	return error;
}

/**
 * The project is the source of truth for tenant scope (a personal project
 * has no organization even when the session has an active one).
 */
export async function resolveProjectTenant(
	projectId: string,
): Promise<string | null> {
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { organizationId: true },
	});
	if (!project) {
		throw new ORPCError("NOT_FOUND", { message: "Project not found" });
	}
	return project.organizationId ?? null;
}

export const acceptSpikeProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.AGENT_EXECUTE))
	.route({
		method: "POST",
		path: "/coding-runs/{codingRunId}/accept-spike",
		tags: ["CodingRuns"],
		summary: "Accept a DEMO_READY spike and apply its findings",
	})
	.input(
		z.object({
			codingRunId: z.string(),
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			/** Who tried the demo, what happened, and the decision. */
			playNotes: z.string().min(20).max(4000),
			nextTrack: spikeNextTrackSchema.optional(),
		}),
	)
	.output(
		z.object({
			codingRunId: z.string(),
			status: z.literal("COMPLETED"),
			storyId: z.string(),
			version: z.number(),
			stageTransition: stageTransitionOutcomeSchema,
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;
		const organizationId = await resolveProjectTenant(input.projectId);

		let result: Awaited<ReturnType<typeof applySpikeFindings>>;
		try {
			result = await applySpikeFindings({
				codingRunId: input.codingRunId,
				projectId: input.projectId,
				organizationId,
				userId: user.id,
				playNotes: input.playNotes,
				nextTrack: input.nextTrack,
			});
		} catch (error) {
			throw mapSpikeRunError(error);
		}

		await addCodingRunEvent(input.codingRunId, "spike_accepted", {
			acceptedBy: user.id,
			version: result.version,
			stageTransition: result.stageTransition,
			nextTrack: input.nextTrack ?? null,
		}).catch((error) => {
			logger.warn(
				{ err: error, codingRunId: input.codingRunId },
				"[CodingRun] Failed to record spike_accepted event",
			);
		});

		await logWorkflowEvent(
			"AGENT_COMPLETED",
			`coding-run-${input.codingRunId}`,
			user.id,
			true,
			{
				organizationId: organizationId ?? undefined,
				projectId: input.projectId,
				storyId: result.storyId,
				codingRunId: input.codingRunId,
				kind: "SPIKE",
				nextTrack: input.nextTrack ?? null,
				source: "coding_runs_accept_spike",
			},
		).catch((error) => {
			logger.warn(
				{ err: error, codingRunId: input.codingRunId },
				"[AuditLog] Failed to log spike acceptance",
			);
		});

		return {
			codingRunId: result.codingRunId,
			status: result.status,
			storyId: result.storyId,
			version: result.version,
			stageTransition: result.stageTransition,
		};
	});
