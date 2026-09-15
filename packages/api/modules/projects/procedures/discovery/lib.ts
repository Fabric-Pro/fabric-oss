/**
 * Shared helpers for the Discovery run procedures (plan Slice 4).
 */

import { z } from "zod";

/** Deterministic workflow id: derivable from the run row. */
export function discoveryRunWorkflowId(discoveryRunId: string): string {
	return `discovery-run-${discoveryRunId}`;
}

/** Partial unique index from the Slice 4 migration (one active run per story). */
export const ACTIVE_DISCOVERY_RUN_INDEX = "discovery_run_one_active_per_story";
export const ACTIVE_DISCOVERY_RUN_CONFLICT_MESSAGE =
	"A discovery run is already active for this feature.";

/** Statuses covered by the partial unique index. */
export const ACTIVE_DISCOVERY_RUN_STATUSES = [
	"QUEUED",
	"RUNNING",
	"CONTRACT_READY",
] as const;

const discoveryRunStatusSchema = z.enum([
	"QUEUED",
	"RUNNING",
	"CONTRACT_READY",
	"COMPLETED",
	"FAILED",
	"CANCELLED",
]);

export const discoverySourcesSchema = z.object({
	repo: z.boolean().optional(),
	openApi: z
		.union([
			z.object({ contextId: z.string().min(1) }),
			z.object({ url: z.string().url().max(2_048) }),
		])
		.optional(),
	mcpConfigIds: z.array(z.string().min(1)).max(10).optional(),
});

export type DiscoverySourcesInput = z.infer<typeof discoverySourcesSchema>;

export const discoveryRunOutputSchema = z.object({
	id: z.string(),
	projectId: z.string(),
	storyId: z.string(),
	userId: z.string(),
	organizationId: z.string().nullable(),
	status: discoveryRunStatusSchema,
	sources: discoverySourcesSchema,
	documentId: z.string().nullable(),
	workflowId: z.string().nullable(),
	error: z.string().nullable(),
	createdAt: z.date(),
	updatedAt: z.date(),
	document: z
		.object({
			id: z.string(),
			title: z.string(),
			status: z.string(),
			isActive: z.boolean(),
		})
		.nullable(),
});

export type DiscoveryRunOutput = z.infer<typeof discoveryRunOutputSchema>;

/** Temporal's typed errors, matched by name (`@temporalio/client` is not a direct dependency). */
export function isWorkflowNotFoundError(error: unknown): boolean {
	return error instanceof Error && error.name === "WorkflowNotFoundError";
}

export function isWorkflowAlreadyStartedError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.name === "WorkflowExecutionAlreadyStartedError"
	);
}

/** Coerce the JSON column back to the sources shape (fail soft to `{}`). */
export function parseStoredSources(value: unknown): DiscoverySourcesInput {
	const parsed = discoverySourcesSchema.safeParse(value);
	return parsed.success ? parsed.data : {};
}
