import {
	CONTEXT_QUALITY_MAX_BYTES,
	contextQualityCasesSchema,
} from "@repo/rag/lib/context-quality";
import { z } from "zod";

const CONTEXT_QUALITY_MAX_SELECTED_SOURCES = 8;
export const contextQualityIdSchema = z.string().max(128).trim().min(1);

/** No actor, tenant, provider location or source bytes are accepted from a client. */
export const projectContextEvaluationSchema = z
	.strictObject({
		version: z.literal(1),
		sources: z
			.array(
				z.strictObject({
					sourceId: contextQualityIdSchema,
					expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
				}),
			)
			.min(1)
			.max(CONTEXT_QUALITY_MAX_SELECTED_SOURCES),
		cases: contextQualityCasesSchema,
	})
	.superRefine((value, context) => {
		if (
			new Set(value.sources.map((source) => source.sourceId)).size !==
			value.sources.length
		) {
			context.addIssue({
				code: "custom",
				message: "Choose each source once.",
			});
		}
		if (
			Buffer.byteLength(JSON.stringify(value), "utf8") >
			CONTEXT_QUALITY_MAX_BYTES
		) {
			context.addIssue({
				code: "custom",
				message: "Evaluation request is too large.",
			});
		}
	});

export type ProjectContextEvaluationInput = z.infer<
	typeof projectContextEvaluationSchema
>;
