import { z } from "zod";

/**
 * Validation schemas for coding execution providers
 * Ensures type safety and input validation at runtime boundaries
 * Compatible with Zod 4.x
 */

// Define artifact schema
const ArtifactSchema = z.object({
	id: z.string(),
	type: z.string(),
	url: z.string().nullable(),
	metadata: z.nullable(z.record(z.string(), z.unknown())),
	createdAt: z.number(),
});

export const CreateSessionParamsSchema = z.object({
	repoOwner: z.string().min(1, "Repository owner is required"),
	repoName: z.string().min(1, "Repository name is required"),
	projectName: z.string().min(1).optional(),
	organizationName: z.string().min(1).optional(),
	vibeRemoteProjectId: z.string().min(1).optional(),
	vibeRemoteProjectName: z.string().min(1).optional(),
	title: z.string().min(1).optional(),
	branch: z.string().min(1).optional(),
	userId: z.string().min(1).optional(),
	workingDirectory: z.string().min(1).optional(),
	promptText: z.string().min(1).optional(),
});

export type ValidatedCreateSessionParams = z.infer<
	typeof CreateSessionParamsSchema
>;

export const SessionStatusSchema = z.object({
	id: z.string(),
	status: z.enum([
		"created",
		"active",
		"completed",
		"failed",
		"stopped",
		"archived",
	]),
	branchName: z.string().nullable(),
	artifacts: z.array(ArtifactSchema),
});

export type ValidatedSessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionResultSchema = z.object({
	sessionId: z.string(),
	externalUrl: z.string().min(1).optional(),
	externalStatus: z.string().min(1).optional(),
	providerMetadata: z.record(z.string(), z.unknown()).optional(),
});

export type ValidatedSessionResult = z.infer<typeof SessionResultSchema>;

/**
 * Validates and transforms input params
 * @throws {Error} if validation fails
 */
export function validateCreateSessionParams(
	params: unknown,
): ValidatedCreateSessionParams {
	const result = CreateSessionParamsSchema.safeParse(params);
	if (!result.success) {
		const issues = result.error.issues
			.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
			.join(", ");
		throw new Error(`Invalid session params: ${issues}`);
	}
	return result.data;
}

/**
 * Validates session status response
 */
export function validateSessionStatus(status: unknown): ValidatedSessionStatus {
	const result = SessionStatusSchema.safeParse(status);
	if (!result.success) {
		const issues = result.error.issues
			.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
			.join(", ");
		throw new Error(`Invalid session status: ${issues}`);
	}
	return result.data;
}
