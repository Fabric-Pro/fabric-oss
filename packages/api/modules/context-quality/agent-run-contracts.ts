import { z } from "zod";
import { contextQualityIdSchema } from "./contracts";

const phrase = z.string().trim().min(1).max(512);
export const inspectAgentResultSchema = z.strictObject({
	executionId: contextQualityIdSchema,
});
export const evaluateAgentResultSchema = inspectAgentResultSchema
	.extend({
		expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
		requiredPhrases: z.array(phrase).max(20),
		forbiddenPhrases: z.array(phrase).max(20),
	})
	.refine((v) => v.requiredPhrases.length + v.forbiddenPhrases.length > 0, {
		message: "Add at least one phrase expectation.",
	});
export type AgentResultExpectations = z.infer<typeof evaluateAgentResultSchema>;
