import { z } from "zod";

/** Public identity of the model that served an answer. */
export const answerModelInfoSchema = z.object({
	id: z.string().min(1),
	canonicalName: z.string().optional(),
	provider: z.string().optional(),
	viaPlan: z.boolean(),
	contextWindow: z.number().positive().optional(),
});

export interface AnswerModelInfo {
	id: string;
	canonicalName?: string;
	provider?: string;
	viaPlan?: boolean;
	contextWindow?: number;
}

export function answerModelInfo(model: {
	modelString: string;
	canonicalName?: string;
	provider?: unknown;
	planSource?: unknown;
	contextWindow?: number;
}): AnswerModelInfo {
	return {
		id: model.modelString,
		canonicalName: model.canonicalName,
		provider: model.provider == null ? undefined : String(model.provider),
		viaPlan: model.provider === "OPENAI_CHATGPT_PLAN" || !!model.planSource,
		contextWindow: model.contextWindow,
	};
}
