/**
 * Tests for the semantic chunking module
 *
 * Run with: pnpm --filter @repo/rag test:semantic
 */

import {
	chunkSemantic,
	chunkSemanticFallback,
	cosineSimilarity,
} from "./semantic";

// Test utilities
function assert(condition: boolean, message: string): void {
	if (!condition) {
		throw new Error(`Assertion failed: ${message}`);
	}
}

function assertApproxEqual(
	actual: number,
	expected: number,
	tolerance: number,
	message: string,
): void {
	if (Math.abs(actual - expected) > tolerance) {
		throw new Error(
			`${message}: expected ${expected} ± ${tolerance}, got ${actual}`,
		);
	}
}

const TEST_TEXT = `
# Introduction to Machine Learning

Machine learning is a subset of artificial intelligence that enables systems to learn from data.
It has revolutionized many industries including healthcare, finance, and transportation.

## Supervised Learning

In supervised learning, the model learns from labeled training data.
Common algorithms include linear regression, decision trees, and neural networks.
The goal is to make predictions on new, unseen data.

## Unsupervised Learning

Unsupervised learning works with unlabeled data.
Clustering and dimensionality reduction are common techniques.
K-means and PCA are popular algorithms in this category.

## Deep Learning

Deep learning uses neural networks with many layers.
It has achieved remarkable results in image recognition and natural language processing.
GPT and BERT are examples of deep learning models for text.
`;

async function runTests() {
	console.log(
		"╔════════════════════════════════════════════════════════════╗",
	);
	console.log(
		"║  Semantic Chunking Tests                                   ║",
	);
	console.log(
		"╚════════════════════════════════════════════════════════════╝\n",
	);

	let passed = 0;
	let failed = 0;

	// Test 1: Cosine similarity - identical vectors
	try {
		console.log("1️⃣  Testing cosine similarity (identical vectors)...");
		const v1 = [1, 0, 0];
		const similarity = cosineSimilarity(v1, v1);
		assertApproxEqual(
			similarity,
			1.0,
			0.001,
			"Identical vectors should have similarity 1",
		);
		console.log(`   ✅ Similarity = ${similarity.toFixed(4)}`);
		passed++;
	} catch (error) {
		console.error(`   ❌ ${error}`);
		failed++;
	}

	// Test 2: Cosine similarity - orthogonal vectors
	try {
		console.log("\n2️⃣  Testing cosine similarity (orthogonal vectors)...");
		const v1 = [1, 0, 0];
		const v2 = [0, 1, 0];
		const similarity = cosineSimilarity(v1, v2);
		assertApproxEqual(
			similarity,
			0.0,
			0.001,
			"Orthogonal vectors should have similarity 0",
		);
		console.log(`   ✅ Similarity = ${similarity.toFixed(4)}`);
		passed++;
	} catch (error) {
		console.error(`   ❌ ${error}`);
		failed++;
	}

	// Test 3: Cosine similarity - opposite vectors
	try {
		console.log("\n3️⃣  Testing cosine similarity (opposite vectors)...");
		const v1 = [1, 0, 0];
		const v2 = [-1, 0, 0];
		const similarity = cosineSimilarity(v1, v2);
		assertApproxEqual(
			similarity,
			-1.0,
			0.001,
			"Opposite vectors should have similarity -1",
		);
		console.log(`   ✅ Similarity = ${similarity.toFixed(4)}`);
		passed++;
	} catch (error) {
		console.error(`   ❌ ${error}`);
		failed++;
	}

	// Test 4: Fallback chunking
	try {
		console.log("\n4️⃣  Testing fallback chunking (no embeddings)...");
		const chunks = chunkSemanticFallback(TEST_TEXT, "test.md", {
			maxChunkSize: 500,
			minChunkSize: 100,
		});
		assert(chunks.length > 0, "Should produce at least one chunk");
		assert(
			chunks.every((c) => c.metadata.strategy === "SEMANTIC"),
			"All chunks should have SEMANTIC strategy",
		);
		console.log(`   ✅ Created ${chunks.length} chunks`);
		chunks.forEach((c, i) => {
			console.log(
				`      Chunk ${i + 1}: ${c.content.length} chars, ~${c.tokenEstimate} tokens`,
			);
		});
		passed++;
	} catch (error) {
		console.error(`   ❌ ${error}`);
		failed++;
	}

	// Test 5: Semantic chunking (requires API key)
	try {
		console.log("\n5️⃣  Testing semantic chunking (with embeddings)...");
		if (!process.env.AI_GATEWAY_API_KEY) {
			console.log("   ⚠️  Skipped: AI_GATEWAY_API_KEY not set");
		} else {
			const chunks = await chunkSemantic(TEST_TEXT, "test.md", {
				maxChunkSize: 500,
				minChunkSize: 100,
				similarityThreshold: 0.5,
				apiKey: process.env.AI_GATEWAY_API_KEY,
			});
			assert(chunks.length > 0, "Should produce at least one chunk");
			console.log(`   ✅ Created ${chunks.length} semantic chunks`);
			chunks.forEach((c, i) => {
				console.log(
					`      Chunk ${i + 1}: ${c.content.length} chars, ~${c.tokenEstimate} tokens`,
				);
			});
			passed++;
		}
	} catch (error) {
		console.error(`   ❌ ${error}`);
		failed++;
	}

	// Summary
	console.log(
		"\n╔════════════════════════════════════════════════════════════╗",
	);
	console.log(
		"║  Test Summary                                              ║",
	);
	console.log(
		"╚════════════════════════════════════════════════════════════╝\n",
	);
	console.log(`   ✅ Passed: ${passed}`);
	console.log(`   ❌ Failed: ${failed}`);
	console.log(`   Total: ${passed + failed}\n`);

	if (failed === 0) {
		console.log("🎉 All semantic chunking tests passed!\n");
		process.exit(0);
	} else {
		console.log("⚠️  Some tests failed.\n");
		process.exit(1);
	}
}

runTests().catch((error) => {
	console.error("Fatal error:", error);
	process.exit(1);
});
