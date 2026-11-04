import { countTokens, truncateToTokens } from "../chunking/tokenizer";
import { MAX_RETRIEVAL_QUERY_TOKENS, MAX_TOKENS_PER_INPUT } from "./limits";

/** Bound retrieval input without discarding indexed document content. */
export function boundQueryForEmbedding(text: string): string {
	return countTokens(text) > MAX_TOKENS_PER_INPUT
		? truncateToTokens(text, MAX_RETRIEVAL_QUERY_TOKENS)
		: text;
}
