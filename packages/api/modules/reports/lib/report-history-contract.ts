import { reportConnectionDiagnosticsSchema } from "@repo/database/prisma/queries/lib/report-public-diagnostics";
import { z } from "zod";
export const nativeExecutionHistoryInput = z.strictObject({
	instanceId: z.string().min(1),
	cursor: z.string().min(1).max(2048).optional(),
	limit: z.number().int().min(1).max(50).default(10),
	status: z
		.enum(["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"])
		.optional(),
});
export const nativeArtifactHistoryInput = z.strictObject({
	executionId: z.string().min(1),
	cursor: z.string().min(1).max(2048).optional(),
	limit: z.number().int().min(1).max(50).default(20),
	artifactType: z
		.enum([
			"MARKDOWN",
			"PDF",
			"HTML",
			"EVIDENCE_EMBED",
			"CHART_DATA",
			"CSV",
			"JSON",
		])
		.optional(),
});
export const nativeArtifactReferenceSchema = z.object({
	id: z.string(),
	executionId: z.string(),
	name: z.string(),
	artifactType: z.string(),
	mimeType: z.string(),
	size: z.number().nullable(),
	createdAt: z.string(),
	linkedFrameId: z.string().nullable(),
	artifactHash: z.string().nullable(),
});
export const nativeExecutionHistoryOutput = z.object({
	executions: z.array(
		z.object({
			id: z.string(),
			instanceId: z.string(),
			userId: z.string(),
			status: z.enum([
				"PENDING",
				"RUNNING",
				"COMPLETED",
				"FAILED",
				"CANCELLED",
			]),
			startedAt: z.string().nullable(),
			completedAt: z.string().nullable(),
			duration: z.number().nullable(),
			error: z.string().nullable(),
			mcpDiagnostics: reportConnectionDiagnosticsSchema,
			createdAt: z.string(),
			artifacts: z.array(nativeArtifactReferenceSchema),
		}),
	),
	hasMore: z.boolean(),
	nextCursor: z.string().nullable(),
});
export const nativeArtifactHistoryOutput = z.object({
	artifacts: z.array(nativeArtifactReferenceSchema),
	hasMore: z.boolean(),
	nextCursor: z.string().nullable(),
});
