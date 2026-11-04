import { generateEmbedding } from "./generator";
import { boundQueryForEmbedding } from "./query-bound";

export { boundQueryForEmbedding } from "./query-bound";

export function generateQueryEmbedding(
	text: string,
	...options: Parameters<typeof generateEmbedding> extends [
		string,
		...infer Options,
	]
		? Options
		: never
): ReturnType<typeof generateEmbedding> {
	return generateEmbedding(boundQueryForEmbedding(text), ...options);
}
