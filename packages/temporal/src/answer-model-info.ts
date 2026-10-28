/** Public identity of the model that served an answer. */
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
		provider: String(model.provider),
		viaPlan: model.provider === "OPENAI_CHATGPT_PLAN" || !!model.planSource,
		contextWindow: model.contextWindow,
	};
}
