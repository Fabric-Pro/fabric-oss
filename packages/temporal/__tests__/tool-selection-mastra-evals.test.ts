import { createScorer } from "@mastra/core/evals";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { shouldSearchIntegrations } from "../src/activities/orchestrator/routing/analyze-and-route";

interface RankedCandidate {
	toolName: string;
	serverName: string;
	hybridScore: number;
	outerKeywordScore?: number;
	keywordScore?: number;
}

interface RankingCase {
	name: string;
	expectedTopTool: string;
	semanticCandidates: RankedCandidate[];
	lexicalCandidates?: Array<RankedCandidate & { keywordScore: number }>;
}

function rankBaseline(caseDef: RankingCase): string[] {
	return [...caseDef.semanticCandidates]
		.map((candidate) => ({
			...candidate,
			score:
				candidate.outerKeywordScore && candidate.outerKeywordScore > 0
					? 0.6 * candidate.hybridScore +
						0.4 * candidate.outerKeywordScore
					: candidate.hybridScore,
		}))
		.sort((a, b) => b.score - a.score)
		.map((candidate) => candidate.toolName);
}

function rankOptimized(caseDef: RankingCase): string[] {
	const lexicalMatches =
		caseDef.lexicalCandidates
			?.filter((candidate) => candidate.keywordScore >= 0.7)
			.sort((a, b) => b.keywordScore - a.keywordScore)
			.map((candidate) => candidate.toolName) ?? [];

	if (lexicalMatches.length > 0) {
		return lexicalMatches;
	}

	return [...caseDef.semanticCandidates]
		.sort((a, b) => b.hybridScore - a.hybridScore)
		.map((candidate) => candidate.toolName);
}

const rankingScorer = createScorer({
	id: "tool-selection-top-rank",
	description:
		"Scores whether the expected tool is ranked first or near the top.",
	type: {
		input: z.object({ expectedTopTool: z.string() }),
		output: z.array(z.string()),
	},
})
	.preprocess(({ run }) => {
		const expectedTopTool = run.input?.expectedTopTool ?? "";
		const ranking = run.output ?? [];
		const rank = ranking.indexOf(expectedTopTool);
		return { rank };
	})
	.generateScore(({ results }) => {
		const rank = results.preprocessStepResult?.rank ?? -1;
		if (rank === 0) {
			return 100;
		}
		if (rank > 0 && rank < 3) {
			return 60;
		}
		return 0;
	});

const integrationScorer = createScorer({
	id: "integration-search-efficiency",
	description:
		"Rewards doing integration search only when it is actually needed.",
	type: {
		input: z.object({ expected: z.boolean() }),
		output: z.boolean(),
	},
})
	.preprocess(({ run }) => ({
		expected: run.input?.expected ?? false,
		actual: run.output,
	}))
	.generateScore(({ results }) =>
		results.preprocessStepResult?.expected ===
		results.preprocessStepResult?.actual
			? 100
			: 0,
	);

describe("Mastra tool selection evals", () => {
	it("improves ranking quality over the baseline heuristics", async () => {
		const cases: RankingCase[] = [
			{
				name: "removes duplicate keyword overweighting",
				expectedTopTool: "context7_query_docs",
				semanticCandidates: [
					{
						toolName: "context7_query_docs",
						serverName: "Context7",
						hybridScore: 0.74,
					},
					{
						toolName: "fabric_search_and_analyze",
						serverName: "Fabric AI",
						hybridScore: 0.68,
						outerKeywordScore: 1,
					},
				],
			},
			{
				name: "full corpus lexical short-circuit recovers a lexical winner missing from semantic top-k",
				expectedTopTool: "jira_get_issue",
				semanticCandidates: [
					{
						toolName: "fabric_search_and_analyze",
						serverName: "Fabric AI",
						hybridScore: 0.62,
						outerKeywordScore: 0.8,
					},
					{
						toolName: "workspace_rag_query",
						serverName: "Fabric AI",
						hybridScore: 0.41,
					},
				],
				lexicalCandidates: [
					{
						toolName: "jira_get_issue",
						serverName: "Jira",
						hybridScore: 0.35,
						keywordScore: 0.96,
					},
				],
			},
			{
				name: "keeps lexical server-specific doc tools ahead of generic web search",
				expectedTopTool: "docs_lookup_api",
				semanticCandidates: [
					{
						toolName: "docs_lookup_api",
						serverName: "Internal Docs",
						hybridScore: 0.71,
					},
					{
						toolName: "fabric_web_search",
						serverName: "Fabric AI",
						hybridScore: 0.67,
						outerKeywordScore: 0.92,
					},
				],
				lexicalCandidates: [
					{
						toolName: "docs_lookup_api",
						serverName: "Internal Docs",
						hybridScore: 0.71,
						keywordScore: 0.88,
					},
				],
			},
		];

		const baselineScores = await Promise.all(
			cases.map(async (caseDef) => {
				const result = await rankingScorer.run({
					input: { expectedTopTool: caseDef.expectedTopTool },
					output: rankBaseline(caseDef),
				});
				return result.score;
			}),
		);

		const optimizedScores = await Promise.all(
			cases.map(async (caseDef) => {
				const result = await rankingScorer.run({
					input: { expectedTopTool: caseDef.expectedTopTool },
					output: rankOptimized(caseDef),
				});
				return result.score;
			}),
		);

		const baselineAverage =
			baselineScores.reduce((sum, score) => sum + score, 0) /
			baselineScores.length;
		const optimizedAverage =
			optimizedScores.reduce((sum, score) => sum + score, 0) /
			optimizedScores.length;

		expect(optimizedAverage).toBeGreaterThan(baselineAverage);
		expect(optimizedAverage).toBe(100);
	});

	it("improves integration search efficiency over the baseline behavior", async () => {
		const cases = [
			{
				expected: false,
				message: "Summarize the project notes into a concise update",
				toolResults: [
					{
						toolName: "workspace_rag_query",
						serverName: "Fabric AI",
						confidence: 0.91,
					},
				],
				userIntent: {},
			},
			{
				expected: true,
				message: "Send a Slack message to the design team",
				toolResults: [
					{
						toolName: "workspace_rag_query",
						serverName: "Fabric AI",
						confidence: 0.91,
					},
				],
				userIntent: {},
			},
			{
				expected: true,
				message: "What is the latest GitHub PR status for the web app?",
				toolResults: [
					{
						toolName: "workspace_rag_query",
						serverName: "Fabric AI",
						confidence: 0.9,
					},
				],
				userIntent: {},
			},
		];

		const baselineScores = await Promise.all(
			cases.map(async (caseDef) => {
				const result = await integrationScorer.run({
					input: { expected: caseDef.expected },
					output: true,
				});
				return result.score;
			}),
		);

		const optimizedScores = await Promise.all(
			cases.map(async (caseDef) => {
				const result = await integrationScorer.run({
					input: { expected: caseDef.expected },
					output: shouldSearchIntegrations(caseDef),
				});
				return result.score;
			}),
		);

		const baselineAverage =
			baselineScores.reduce((sum, score) => sum + score, 0) /
			baselineScores.length;
		const optimizedAverage =
			optimizedScores.reduce((sum, score) => sum + score, 0) /
			optimizedScores.length;

		expect(optimizedAverage).toBeGreaterThan(baselineAverage);
		expect(optimizedAverage).toBe(100);
	});
});
