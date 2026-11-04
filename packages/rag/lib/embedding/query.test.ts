import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { countTokens } from "../chunking/tokenizer";
import { generateEmbedding } from "./generator";
import { MAX_RETRIEVAL_QUERY_TOKENS, MAX_TOKENS_PER_INPUT } from "./limits";
import { boundQueryForEmbedding, generateQueryEmbedding } from "./query";

vi.mock("./generator", () => ({
	generateEmbedding: vi.fn().mockResolvedValue({ embedding: [1] }),
}));

describe("query embedding bounds", () => {
	it("cuts an oversized real-text query and forwards all options", async () => {
		const text =
			"The service returned an error while processing the document.\n".repeat(
				1200,
			);
		expect(countTokens(text)).toBeGreaterThan(MAX_TOKENS_PER_INPUT);
		const tenant = { userId: "example-user" };
		const signal = new AbortController().signal;
		await generateQueryEmbedding(text, tenant, undefined, signal);
		const cut = vi.mocked(generateEmbedding).mock.lastCall?.[0] ?? "";
		expect(cut.length).toBeGreaterThan(0);
		expect(countTokens(cut)).toBeLessThanOrEqual(
			MAX_RETRIEVAL_QUERY_TOKENS,
		);
		expect(generateEmbedding).toHaveBeenLastCalledWith(
			boundQueryForEmbedding(text),
			tenant,
			undefined,
			signal,
		);
	});
	it("preserves short queries including whitespace", async () => {
		const text = "  find this log\n";
		await generateQueryEmbedding(text, { userId: "example-user" });
		expect(generateEmbedding).toHaveBeenLastCalledWith(text, {
			userId: "example-user",
		});
	});
	it("preserves queries between the retrieval budget and provider ceiling", () => {
		const text = " hello".repeat(MAX_TOKENS_PER_INPUT);
		expect(countTokens(text)).toBe(MAX_TOKENS_PER_INPUT);
		expect(boundQueryForEmbedding(text)).toBe(text);
	});
	const callers: Array<[string, string, string]> = [
		[
			"apps/web/modules/saas/mcp/lib/gateway/platform-tools.ts",
			"generateQueryEmbedding",
			"query",
		],
		[
			"packages/agent-core/src/services/semantic-memory.ts",
			"generateQueryEmbedding",
			"query",
		],
		[
			"packages/api/modules/projects/lib/knowledge.ts",
			"generateQueryEmbedding",
			"params.query",
		],
		[
			"packages/rag/lib/project-contexts/code-search.ts",
			"generateQueryEmbedding",
			"input.query",
		],
		[
			"packages/rag/lib/project-contexts/retrieval.ts",
			"generateQueryEmbedding",
			"boundedQuery",
		],
		[
			"packages/rag/lib/retrieval/retriever.ts",
			"generateQueryEmbedding",
			"query",
		],
		[
			"packages/rag/lib/unified-search/project-search.ts",
			"generateQueryEmbedding",
			"options.query",
		],
		[
			"packages/rag/lib/wizard-contexts/retrieval.ts",
			"generateQueryEmbedding",
			"query",
		],
		[
			"packages/temporal/src/activities/direct-chat/built-in-tools.ts",
			"generateQueryEmbedding",
			"query",
		],
		[
			"packages/temporal/src/activities/direct-chat/rag-retrieval.ts",
			"generateQueryEmbedding",
			"message",
		],
		[
			"packages/temporal/src/activities/orchestrator-memory-activities.ts",
			"generateQueryEmbedding",
			"query",
		],
		[
			"packages/temporal/src/activities/orchestrator/execution/handlers/code-search-handler.ts",
			"generateQueryEmbedding",
			"query",
		],
		[
			"packages/temporal/src/activities/orchestrator/tools/capability-embeddings.ts",
			"generateQueryEmbedding",
			"text",
		],
		[
			"packages/temporal/src/activities/orchestrator/tools/search-agents.ts",
			"generateQueryEmbedding",
			"input.query",
		],
		[
			"packages/temporal/src/activities/orchestrator/tools/search-integrations.ts",
			"generateQueryEmbedding",
			"input.query",
		],
		[
			"packages/temporal/src/activities/orchestrator/tools/search-workflows.ts",
			"generateQueryEmbedding",
			"input.query",
		],
		[
			"packages/temporal/src/activities/orchestrator/tools/tool-index.ts",
			"generateQueryEmbedding",
			"query",
		],
		[
			"packages/temporal/src/activities/template-instance/data-fetching.ts",
			"generateQueryEmbedding",
			"task",
		],
		[
			"packages/temporal/src/lib/company-context-search.ts",
			"generateQueryEmbedding",
			"query",
		],
		[
			"packages/temporal/src/activities/orchestrator/routing/semantic-intent-matcher.ts",
			"generateEmbedding",
			"boundQueryForEmbedding(message)",
		],
		[
			"apps/web/app/api/workspaces/chat/workspace-chat-turn.ts",
			"value",
			"boundedQuery",
		],
		[
			"packages/temporal/src/activities/orchestrator-memory/index.ts",
			"value",
			"boundQueryForEmbedding(query)",
		],
		[
			"packages/temporal/src/activities/orchestrator/tools/search-tools.ts",
			"generateEmbeddings",
			"[boundQueryForEmbedding(query)]",
		],
		[
			"packages/rag/lib/project-contexts/search-hits.ts",
			"boundQueryForEmbedding",
			"query",
		],
		[
			"packages/temporal/src/activities/chunking-analysis.ts",
			"expression",
			"questions.map((q)=>boundQueryForEmbedding(q.question))",
		],
	];
	for (const [file, call, argument] of callers) {
		it(`bounds retrieval query in ${file}`, () => {
			const source = readFileSync(
				resolve(import.meta.dirname, "../../../..", file),
				"utf8",
			);
			const compact = source.replace(/\s+/g, "").replace(/,\)/g, ")");
			expect(compact).toContain(
				call === "expression"
					? argument
					: call === "value"
						? `value:${argument.replace(/\s+/g, "")}`
						: `${call}(${argument.replace(/\s+/g, "")}${call === "boundQueryForEmbedding" ? ")" : ","}`,
			);
			if (
				call === "generateQueryEmbedding" &&
				source.includes("generateSparseVector(")
			) {
				expect(compact).toContain(
					`generateSparseVector(boundQueryForEmbedding(${argument.replace(/\s+/g, "")}))`,
				);
			}
			if (argument === "boundedQuery" && call === "value") {
				expect(compact).toContain(
					"constboundedQuery=boundQueryForEmbedding(message)",
				);
				expect(compact).toContain("generateSparseVector(boundedQuery)");
			}
		});
	}
});
