import { contextQualityResultSchema } from "@repo/rag/lib/context-quality";
import { z } from "zod";
import {
	contextQualityIdSchema,
	projectContextEvaluationSchema,
} from "./contracts";

const savedEvaluationStates = [
	"QUEUED",
	"EXPORTING",
	"DISPATCHING",
	"RUNNING",
	"CANCEL_REQUESTED",
	"SUCCEEDED",
	"FAILED",
	"CANCELLED",
	"RECONCILIATION_REQUIRED",
] as const;

export const savedEvaluationScopeSchema = z.strictObject({
	projectId: contextQualityIdSchema,
	organizationId: contextQualityIdSchema.optional(),
});

export const createSavedEvaluationSchema = z.strictObject({
	bindingId: contextQualityIdSchema,
	idempotencyKey: z
		.string()
		.min(8)
		.max(128)
		.regex(/^[A-Za-z0-9_-]+$/),
	name: z.string().trim().min(1).max(80).optional(),
	evaluation: projectContextEvaluationSchema,
});

export const savedEvaluationListSchema = z.strictObject({
	limit: z.number().int().min(1).max(50).default(20),
	cursor: contextQualityIdSchema.optional(),
});

export const savedEvaluationBindingSchema = z.strictObject({
	integrationId: contextQualityIdSchema,
	workspaceOrigin: z.string().min(1).max(256),
	jobId: z
		.string()
		.regex(/^[1-9][0-9]{0,15}$/)
		.refine((value) => Number.isSafeInteger(Number(value))),
	experimentId: z
		.string()
		.regex(/^[1-9][0-9]{0,15}$/)
		.refine((value) => Number.isSafeInteger(Number(value))),
	volumeRoot: z.string().min(1).max(512),
	exportApproved: z.literal(true),
	enabled: z.boolean().default(true),
});

export const savedEvaluationRunSchema = z.strictObject({
	id: contextQualityIdSchema,
	projectId: contextQualityIdSchema,
	organizationId: contextQualityIdSchema,
	name: z.string(),
	status: z.enum(savedEvaluationStates),
	report: contextQualityResultSchema.nullable(),
	evidenceAvailable: z.boolean(),
	sourceRefs: z
		.array(
			z.strictObject({
				sourceId: contextQualityIdSchema,
				expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
			}),
		)
		.max(8),
	errorCode: z.string().nullable(),
	cleanupStatus: z.enum(["NOT_REQUIRED", "PENDING", "CONFIRMED", "BLOCKED"]),
	remoteRunUrl: z.string().url().nullable(),
	mlflowRunUrl: z.string().url().nullable(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
	completedAt: z.string().datetime().nullable(),
});

export class SavedEvaluationError extends Error {
	constructor(
		readonly code:
			| "BAD_REQUEST"
			| "FORBIDDEN"
			| "NOT_FOUND"
			| "CONFLICT"
			| "PRECONDITION_FAILED"
			| "SERVICE_UNAVAILABLE",
		message: string,
	) {
		super(message);
		this.name = "SavedEvaluationError";
	}
}
