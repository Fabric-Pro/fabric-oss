import { z } from "zod";

const id = z.string().trim().min(1).max(200);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const phrase = z
	.string()
	.min(1)
	.max(512)
	.refine((value) => value.trim().length > 0);
export const checkIdentitySchema = z.strictObject({ workflowId: id });
export const inspectWorkflowResultSchema = checkIdentitySchema.extend({
	executionId: id,
	nodeId: id,
});
export const phraseExpectationsSchema = z
	.strictObject({
		requiredPhrases: z.array(phrase).max(20),
		forbiddenPhrases: z.array(phrase).max(20),
	})
	.refine((v) => v.requiredPhrases.length + v.forbiddenPhrases.length > 0, {
		message: "Add at least one phrase to check.",
	});
export const previewWorkflowCheckSchema = inspectWorkflowResultSchema
	.extend({ expectedRevision: revision, ...phraseExpectationsSchema.shape })
	.refine((v) => v.requiredPhrases.length + v.forbiddenPhrases.length > 0);
export const saveWorkflowCheckSchema = previewWorkflowCheckSchema.safeExtend({
	name: z.string().trim().min(1).max(120),
});
export const applyWorkflowCheckSchema = checkIdentitySchema.extend({
	checkId: id,
	expectedCaseRevision: revision,
	executionId: id,
});
export const removeWorkflowCheckSchema = checkIdentitySchema.extend({
	checkId: id,
	expectedCaseRevision: revision,
});
export const savedWorkflowCheckSchema = z.strictObject({
	id,
	revision,
	name: z.string().min(1).max(120),
	nodeId: id,
	baselineExecutionId: id,
	baselineVersion: z.number().int().positive(),
	baselineRevision: revision,
	createdAt: z.iso.datetime(),
	...phraseExpectationsSchema.shape,
});
export const workflowCheckCollectionSchema = z.strictObject({
	version: z.literal(1),
	workflowId: id,
	cases: z.array(savedWorkflowCheckSchema).max(20),
});
export type SavedWorkflowCheck = z.infer<typeof savedWorkflowCheckSchema>;
