import {
	resultQualityCheckFields,
	validResultQualityChecks,
} from "@repo/utils/result-quality";
import { z } from "zod";

const id = z.string().trim().min(1).max(200);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const checkIdentitySchema = z.strictObject({ workflowId: id });
export const inspectWorkflowResultSchema = checkIdentitySchema.extend({
	executionId: id,
	nodeId: id,
});
export const phraseExpectationsSchema = z
	.strictObject(resultQualityCheckFields)
	.refine(
		validResultQualityChecks,
		"Add at least one check; JSON and grounding checks require version 2.",
	);
export const previewWorkflowCheckSchema = inspectWorkflowResultSchema
	.extend({ expectedRevision: revision, ...phraseExpectationsSchema.shape })
	.refine(validResultQualityChecks);
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
export const savedWorkflowCheckSchema = z
	.strictObject({
		id,
		revision,
		name: z.string().min(1).max(120),
		nodeId: id,
		baselineExecutionId: id,
		baselineVersion: z.number().int().positive(),
		baselineRevision: revision,
		createdAt: z.iso.datetime(),
		...phraseExpectationsSchema.shape,
	})
	.refine(validResultQualityChecks);
export const workflowCheckCollectionSchema = z.strictObject({
	version: z.literal(1),
	workflowId: id,
	cases: z.array(savedWorkflowCheckSchema).max(20),
});
export type SavedWorkflowCheck = z.infer<typeof savedWorkflowCheckSchema>;
