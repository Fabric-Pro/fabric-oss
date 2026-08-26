/**
 * Tests for the tokenizer module
 *
 * Run with: pnpm --filter @repo/rag test:tokenizer
 */

import { estimateTokenCount } from "./chunker";
import {
	charsToTokensEstimate,
	countTokens,
	countTokensBatch,
	splitByTokens,
	tokensToChars,
	truncateToTokens,
} from "./tokenizer";

// Test utilities
function assert(condition: boolean, message: string): void {
	if (!condition) {
		throw new Error(`Assertion failed: ${message}`);
	}
}

function _assertApproxEqual(
	actual: number,
	expected: number,
	tolerance: number,
	message: string,
): void {
	const diff = Math.abs(actual - expected);
	if (diff > tolerance) {
		throw new Error(
			`${message}: expected ${expected} ± ${tolerance}, got ${actual}`,
		);
	}
}

async function runTests() {
	console.log(
		"╔════════════════════════════════════════════════════════════╗",
	);
	console.log(
		"║  Tokenizer Module Tests                                    ║",
	);
	console.log(
		"╚════════════════════════════════════════════════════════════╝\n",
	);

	let passed = 0;
	let failed = 0;

	// Test 1: Basic token counting
	try {
		console.log("1️⃣  Testing basic token counting...");
		const text = "Hello, world!";
		const tokens = countTokens(text);
		// "Hello, world!" is 4 tokens in cl100k_base: "Hello", ",", " world", "!"
		assert(tokens === 4, `Expected 4 tokens, got ${tokens}`);
		console.log(`   ✅ "${text}" = ${tokens} tokens`);
		passed++;
	} catch (error) {
		console.error(`   ❌ ${error}`);
		failed++;
	}

	// Test 2: Empty string
	try {
		console.log("\n2️⃣  Testing empty string...");
		const tokens = countTokens("");
		assert(tokens === 0, `Expected 0 tokens, got ${tokens}`);
		console.log(`   ✅ Empty string = ${tokens} tokens`);
		passed++;
	} catch (error) {
		console.error(`   ❌ ${error}`);
		failed++;
	}

	// Test 3: Longer text
	try {
		console.log("\n3️⃣  Testing longer text...");
		const text =
			"Retrieval-Augmented Generation (RAG) is a technique that combines information retrieval with text generation.";
		const tokens = countTokens(text);
		// Approximate: should be around 20-25 tokens
		assert(
			tokens > 15 && tokens < 30,
			`Expected 15-30 tokens, got ${tokens}`,
		);
		console.log(`   ✅ Long text = ${tokens} tokens (expected ~20)`);
		passed++;
	} catch (error) {
		console.error(`   ❌ ${error}`);
		failed++;
	}

	// Test 4: Batch token counting
	try {
		console.log("\n4️⃣  Testing batch token counting...");
		const texts = ["Hello", "World", "Hello, world!"];
		const tokenCounts = countTokensBatch(texts);
		assert(
			tokenCounts.length === 3,
			`Expected 3 counts, got ${tokenCounts.length}`,
		);
		assert(tokenCounts[0] === 1, `"Hello" should be 1 token`);
		assert(tokenCounts[1] === 1, `"World" should be 1 token`);
		assert(tokenCounts[2] === 4, `"Hello, world!" should be 4 tokens`);
		console.log(`   ✅ Batch counts: ${tokenCounts.join(", ")}`);
		passed++;
	} catch (error) {
		console.error(`   ❌ ${error}`);
		failed++;
	}

	// Test 5: Token/char conversion
	try {
		console.log("\n5️⃣  Testing token/char conversion...");
		const tokens = 100;
		const chars = tokensToChars(tokens);
		assert(chars === 400, `Expected 400 chars, got ${chars}`);
		const estimatedTokens = charsToTokensEstimate(chars);
		assert(
			estimatedTokens === tokens,
			`Expected ${tokens} tokens, got ${estimatedTokens}`,
		);
		console.log(
			`   ✅ ${tokens} tokens ≈ ${chars} chars ≈ ${estimatedTokens} tokens`,
		);
		passed++;
	} catch (error) {
		console.error(`   ❌ ${error}`);
		failed++;
	}

	// Test 6: Truncate to tokens
	try {
		console.log("\n6️⃣  Testing truncateToTokens...");
		const text = "The quick brown fox jumps over the lazy dog.";
		const truncated = truncateToTokens(text, 5);
		const truncatedTokens = countTokens(truncated);
		assert(
			truncatedTokens <= 5,
			`Expected ≤5 tokens, got ${truncatedTokens}`,
		);
		console.log(
			`   ✅ Truncated to ${truncatedTokens} tokens: "${truncated}"`,
		);
		passed++;
	} catch (error) {
		console.error(`   ❌ ${error}`);
		failed++;
	}

	// Test 7: Split by tokens
	try {
		console.log("\n7️⃣  Testing splitByTokens...");
		const text =
			"One. Two. Three. Four. Five. Six. Seven. Eight. Nine. Ten.";
		const chunks = splitByTokens(text, 5, 1);
		assert(
			chunks.length > 1,
			`Expected multiple chunks, got ${chunks.length}`,
		);
		// Verify each chunk is within limit
		for (const chunk of chunks) {
			const tokens = countTokens(chunk);
			assert(tokens <= 6, `Chunk exceeds limit: ${tokens} tokens`); // Allow 1 extra for overlap
		}
		console.log(`   ✅ Split into ${chunks.length} chunks`);
		passed++;
	} catch (error) {
		console.error(`   ❌ ${error}`);
		failed++;
	}

	// Test 8: estimateTokenCount (accurate)
	try {
		console.log("\n8️⃣  Testing estimateTokenCount (accurate)...");
		const text = "Hello, world!";
		const accurate = estimateTokenCount(text, true);
		const estimate = estimateTokenCount(text, false);
		assert(accurate === 4, `Expected 4 accurate tokens, got ${accurate}`);
		// Estimate should be close but may differ
		console.log(`   ✅ Accurate: ${accurate}, Estimate: ${estimate}`);
		passed++;
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
		console.log("🎉 All tokenizer tests passed!\n");
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
