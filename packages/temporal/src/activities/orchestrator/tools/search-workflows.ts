/**
 * Workflow Search
 *
 * Search for available workflows that can be triggered by the orchestrator.
 */

import { db } from "@repo/database";
import {
	generateEmbedding,
	generateEmbeddings,
} from "@repo/rag/lib/embedding/generator";
import type { TenantContext } from "@repo/rag/lib/embedding/types";
import { cosineSimilarity } from "./capability-embeddings";
import type {
	SearchAvailableWorkflowsInput,
	SearchAvailableWorkflowsOutput,
} from "./types";
import { extractQueryWords } from "./utils";

/**
 * Search for available workflows that match the query.
 * Uses semantic (embedding-based) search combined with keyword matching.
 *
 * Supports explicit workflow name mentions like:
 * - "run the daily report workflow"
 * - "trigger workflow 'data sync'"
 */
export async function searchAvailableWorkflows(
	input: SearchAvailableWorkflowsInput,
): Promise<SearchAvailableWorkflowsOutput> {
	const startTime = Date.now();
	console.log(`[SearchWorkflows] Searching for: "${input.query}"`);

	// XOR PATTERN: Strict tenant isolation
	// Personal workflows are NEVER visible in org context and vice versa
	const tenantFilter = input.organizationId
		? { organizationId: input.organizationId } // Org context: only org workflows
		: { userId: input.userId, organizationId: null }; // Personal: explicit null check

	// Query workflows from database
	const workflows = await db.workflow.findMany({
		where: {
			...tenantFilter,
			status: { in: ["PUBLISHED", "DRAFT"] }, // Include published and drafts
			triggerType: "MANUAL", // Only manually triggerable workflows
		},
	});

	if (workflows.length === 0) {
		return {
			results: [],
			totalWorkflowsSearched: 0,
			durationMs: Date.now() - startTime,
		};
	}

	console.log(
		`[SearchWorkflows] Found ${workflows.length} available workflows`,
	);

	// If user explicitly mentioned a workflow name, prioritize exact/fuzzy match
	if (input.requestedWorkflowName) {
		const requestedName = input.requestedWorkflowName.toLowerCase();
		const exactMatch = workflows.find(
			(w) => w.name.toLowerCase() === requestedName,
		);

		if (exactMatch) {
			console.log(
				`[SearchWorkflows] Found exact match for requested workflow: ${exactMatch.name}`,
			);
			return {
				results: [
					{
						workflowId: exactMatch.id,
						name: exactMatch.name,
						description: exactMatch.description || "",
						confidence: 0.95,
						matchReason: `Exact match for requested workflow: "${input.requestedWorkflowName}"`,
						triggerType: exactMatch.triggerType,
						status: exactMatch.status,
					},
				],
				totalWorkflowsSearched: workflows.length,
				durationMs: Date.now() - startTime,
			};
		}

		// Try fuzzy match on workflow name
		const fuzzyMatches = workflows.filter(
			(w) =>
				w.name.toLowerCase().includes(requestedName) ||
				requestedName.includes(w.name.toLowerCase()),
		);

		if (fuzzyMatches.length > 0) {
			console.log(
				`[SearchWorkflows] Found ${fuzzyMatches.length} fuzzy matches for: ${input.requestedWorkflowName}`,
			);
			return {
				results: fuzzyMatches.map((w) => ({
					workflowId: w.id,
					name: w.name,
					description: w.description || "",
					confidence: 0.85,
					matchReason: `Fuzzy match for requested workflow: "${input.requestedWorkflowName}"`,
					triggerType: w.triggerType,
					status: w.status,
				})),
				totalWorkflowsSearched: workflows.length,
				durationMs: Date.now() - startTime,
			};
		}
	}

	// Generate query embedding for semantic search
	let queryEmbedding: number[] | null = null;
	try {
		const tenantContext: TenantContext = {
			userId: input.userId,
			organizationId: input.organizationId,
		};
		// Credentials are fetched internally by generateEmbedding()
		const result = await generateEmbedding(
			input.query,
			tenantContext,
			undefined,
		);
		queryEmbedding = result.embedding;
	} catch (error) {
		console.warn(
			"[SearchWorkflows] Failed to generate query embedding:",
			error,
		);
	}

	// Generate embeddings for workflows (batch for efficiency)
	const workflowTexts = workflows.map((w) => {
		// Combine name and description for embedding
		return `${w.name}: ${w.description || "No description"}`;
	});

	let workflowEmbeddings: number[][] = [];
	if (queryEmbedding) {
		try {
			const tenantContext: TenantContext = {
				userId: input.userId,
				organizationId: input.organizationId,
			};
			// Credentials are fetched internally by generateEmbeddings()
			const results = await generateEmbeddings(
				workflowTexts,
				tenantContext,
				undefined,
			);
			workflowEmbeddings = results.embeddings;
		} catch (error) {
			console.warn(
				"[SearchWorkflows] Failed to generate workflow embeddings:",
				error,
			);
		}
	}

	// Score workflows using hybrid approach
	const queryWords = extractQueryWords(input.query);

	const scoredWorkflows = workflows
		.map((workflow, index) => {
			// Keyword matching (40% weight)
			const workflowText =
				`${workflow.name} ${workflow.description || ""}`.toLowerCase();
			let keywordScore = 0;
			const matchedKeywords: string[] = [];

			for (const word of queryWords) {
				if (workflowText.includes(word)) {
					keywordScore += 1 / queryWords.length;
					matchedKeywords.push(word);
				}
			}

			// Semantic similarity (60% weight)
			let semanticScore = 0;
			if (queryEmbedding && workflowEmbeddings[index]) {
				semanticScore = cosineSimilarity(
					queryEmbedding,
					workflowEmbeddings[index],
				);
			}

			// Hybrid score
			const hybridScore =
				queryEmbedding && workflowEmbeddings[index]
					? 0.4 * keywordScore + 0.6 * semanticScore
					: keywordScore;

			// Build match reason
			const matchReasons: string[] = [];
			if (matchedKeywords.length > 0) {
				matchReasons.push(`Keywords: ${matchedKeywords.join(", ")}`);
			}
			if (semanticScore > 0.5) {
				matchReasons.push(
					`Semantic: ${(semanticScore * 100).toFixed(0)}%`,
				);
			}

			return {
				workflow,
				score: hybridScore,
				matchReason: matchReasons.join("; ") || "Semantic match",
			};
		})
		.filter((w) => w.score >= (input.minConfidence || 0.2))
		.sort((a, b) => b.score - a.score)
		.slice(0, input.limit || 5);

	const durationMs = Date.now() - startTime;
	const semanticUsed =
		queryEmbedding !== null && workflowEmbeddings.length > 0;

	console.log(
		`[SearchWorkflows] Found ${scoredWorkflows.length} workflows in ${durationMs}ms (semantic: ${semanticUsed})`,
	);

	return {
		results: scoredWorkflows.map((sw) => ({
			workflowId: sw.workflow.id,
			name: sw.workflow.name,
			description: sw.workflow.description || "",
			confidence: sw.score,
			matchReason: sw.matchReason,
			triggerType: sw.workflow.triggerType,
			status: sw.workflow.status,
		})),
		totalWorkflowsSearched: workflows.length,
		durationMs,
	};
}
