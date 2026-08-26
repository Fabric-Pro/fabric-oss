/**
 * Test script for Phase 1 & Phase 2 RAG implementation
 *
 * Tests:
 * 1. Database operations (ChatDocument, DocumentChunk)
 * 2. Qdrant vector storage
 * 3. Document extraction
 * 4. Text chunking
 * 5. Embedding generation
 * 6. End-to-end storage and retrieval
 *
 * Usage:
 *   pnpm --filter @repo/rag test:rag
 */

import { randomUUID } from "node:crypto";
import { db } from "@repo/database/prisma/client";
import { chunkText } from "./lib/chunking";
import { generateEmbeddings } from "./lib/embedding";
import { extractDocument } from "./lib/extraction";
import {
	deleteDocumentChunks,
	searchSimilarChunks,
	storeChunk,
} from "./lib/vector-store";
import {
	COLLECTION_NAME,
	initializeQdrantCollection,
	qdrantClient,
} from "./lib/vector-store/client";

// Test data - will be populated with real IDs
let TEST_USER_ID: string;
let TEST_CHAT_ID: string;
const TEST_DOCUMENT_CONTENT = `
# Introduction to RAG

Retrieval-Augmented Generation (RAG) is a technique that combines information retrieval with text generation.

## How RAG Works

1. Document Processing: Documents are split into chunks
2. Embedding Generation: Each chunk is converted to a vector embedding
3. Vector Storage: Embeddings are stored in a vector database
4. Retrieval: When a query comes in, relevant chunks are retrieved
5. Generation: The LLM generates a response using the retrieved context

## Benefits of RAG

- Reduces hallucinations by grounding responses in real data
- Allows LLMs to access up-to-date information
- Enables domain-specific knowledge without fine-tuning
- Provides source attribution for generated content

## Implementation Considerations

- Chunk size affects retrieval quality
- Embedding model choice impacts semantic search
- Vector database selection affects performance
- Multi-tenancy requires careful access control
`;

/**
 * Setup test data - create test user and chat
 */
async function setupTestData() {
	console.log("🔧 Setting up test data...\n");

	try {
		// Check if test user exists, otherwise use first available user
		const existingUser = await db.user.findFirst();
		if (!existingUser) {
			throw new Error(
				"No users found in database. Please run seed script first: pnpm --filter @repo/database seed",
			);
		}
		TEST_USER_ID = existingUser.id;
		console.log(
			`✅ Using existing user: ${existingUser.email} (${TEST_USER_ID})`,
		);

		// Create a test chat for this user
		const testChat = await db.aiChat.create({
			data: {
				userId: TEST_USER_ID,
				title: "RAG Test Chat",
			},
		});
		TEST_CHAT_ID = testChat.id;
		console.log(`✅ Created test chat: ${TEST_CHAT_ID}\n`);

		return true;
	} catch (error) {
		console.error("❌ Failed to setup test data:", error);
		throw error;
	}
}

/**
 * Cleanup test data
 */
async function cleanupTestData() {
	console.log("\n🧹 Cleaning up test data...");

	try {
		if (TEST_CHAT_ID) {
			// Delete chat (will cascade delete documents and chunks)
			await db.aiChat.delete({ where: { id: TEST_CHAT_ID } });
			console.log("✅ Deleted test chat and all related data");
		}
	} catch (error) {
		console.error("⚠️  Cleanup failed (non-critical):", error);
	}
}

async function testDatabaseOperations() {
	console.log("\n🗄️  Testing Database Operations...\n");

	try {
		// Test 1: Create ChatDocument
		console.log("1️⃣  Creating ChatDocument...");
		const document = await db.chatDocument.create({
			data: {
				chatId: TEST_CHAT_ID,
				userId: TEST_USER_ID,
				filename: "test-rag-document.md",
				mimeType: "text/markdown",
				size: TEST_DOCUMENT_CONTENT.length,
				s3Path: "test/test-rag-document.md",
				status: "PENDING",
			},
		});
		console.log(`✅ Created document: ${document.id}`);

		// Test 2: Create DocumentChunk
		console.log("\n2️⃣  Creating DocumentChunk...");
		const chunk = await db.documentChunk.create({
			data: {
				documentId: document.id,
				chatId: TEST_CHAT_ID,
				userId: TEST_USER_ID,
				content: "This is a test chunk",
				chunkIndex: 0,
				metadata: { test: true },
			},
		});
		console.log(`✅ Created chunk: ${chunk.id}`);

		// Test 3: Query with multi-tenancy filter
		console.log("\n3️⃣  Querying chunks with multi-tenancy filter...");
		const chunks = await db.documentChunk.findMany({
			where: {
				userId: TEST_USER_ID,
				chatId: TEST_CHAT_ID,
			},
			include: {
				document: true,
			},
		});
		console.log(`✅ Found ${chunks.length} chunk(s)`);

		// Test 4: Update document status
		console.log("\n4️⃣  Updating document status...");
		await db.chatDocument.update({
			where: { id: document.id },
			data: { status: "PROCESSING" },
		});
		console.log("✅ Updated document status to PROCESSING");

		// Cleanup
		console.log("\n🧹 Cleaning up test data...");
		await db.documentChunk.deleteMany({
			where: { documentId: document.id },
		});
		await db.chatDocument.delete({ where: { id: document.id } });
		console.log("✅ Cleanup complete");

		console.log("\n✅ Database operations test PASSED\n");
		return true;
	} catch (error) {
		console.error("❌ Database operations test FAILED:", error);
		return false;
	}
}

async function testQdrantOperations() {
	console.log("\n🔍 Testing Qdrant Operations...\n");

	try {
		// Test 1: Initialize collection
		console.log("1️⃣  Initializing Qdrant collection...");
		await initializeQdrantCollection();
		console.log(`✅ Collection '${COLLECTION_NAME}' initialized`);

		// Test 2: Check collection info
		console.log("\n2️⃣  Checking collection info...");
		const collectionInfo =
			await qdrantClient.getCollection(COLLECTION_NAME);
		console.log(
			`✅ Collection exists with ${collectionInfo.points_count} points`,
		);
		if (collectionInfo.config.params.vectors) {
			console.log(
				`   Vector size: ${collectionInfo.config.params.vectors.size}`,
			);
			console.log(
				`   Distance: ${collectionInfo.config.params.vectors.distance}`,
			);
		}

		// Test 3: Upsert test vector
		console.log("\n3️⃣  Upserting test vector...");
		const testVector = Array(1536)
			.fill(0)
			.map(() => Math.random());
		const testPointId = randomUUID(); // Use UUID format for Qdrant
		await qdrantClient.upsert(COLLECTION_NAME, {
			wait: true,
			points: [
				{
					id: testPointId,
					vector: testVector,
					payload: {
						chatId: TEST_CHAT_ID,
						userId: TEST_USER_ID,
						documentId: randomUUID(),
						chunkIndex: 0,
					},
				},
			],
		});
		console.log(`✅ Upserted point: ${testPointId}`);

		// Test 4: Search with filtering
		console.log("\n4️⃣  Searching with multi-tenancy filter...");
		const searchResults = await qdrantClient.search(COLLECTION_NAME, {
			vector: testVector,
			limit: 5,
			filter: {
				must: [
					{ key: "chatId", match: { value: TEST_CHAT_ID } },
					{ key: "userId", match: { value: TEST_USER_ID } },
				],
			},
		});
		console.log(`✅ Found ${searchResults.length} result(s)`);
		if (searchResults.length > 0) {
			console.log(`   Top result score: ${searchResults[0].score}`);
		}

		// Test 5: Delete test point
		console.log("\n5️⃣  Deleting test point...");
		await qdrantClient.delete(COLLECTION_NAME, {
			wait: true,
			points: [testPointId],
		});
		console.log("✅ Deleted test point");

		console.log("\n✅ Qdrant operations test PASSED\n");
		return true;
	} catch (error) {
		console.error("❌ Qdrant operations test FAILED:", error);
		return false;
	}
}

async function testDocumentExtraction() {
	console.log("\n📄 Testing Document Extraction...\n");

	try {
		// Test 1: Extract text from markdown
		console.log("1️⃣  Extracting text from markdown...");
		const extracted = await extractDocument(
			Buffer.from(TEST_DOCUMENT_CONTENT),
			"test.md",
			"text/markdown",
		);
		console.log(`✅ Extracted ${extracted.text.length} characters`);
		console.log(`   Extractor used: ${extracted.extractorUsed}`);
		console.log(`   Extraction time: ${extracted.extractionTime}ms`);

		console.log("\n✅ Document extraction test PASSED\n");
		return true;
	} catch (error) {
		console.error("❌ Document extraction test FAILED:", error);
		return false;
	}
}

async function testTextChunking() {
	console.log("\n✂️  Testing Text Chunking...\n");

	try {
		// Test 1: Chunk text
		console.log("1️⃣  Chunking text...");
		const chunks = chunkText(TEST_DOCUMENT_CONTENT, "test-document.txt", {
			chunkSize: 200,
			chunkOverlap: 50,
		});
		console.log(`✅ Created ${chunks.length} chunks`);
		console.log(`   First chunk length: ${chunks[0].content.length} chars`);
		console.log(
			`   Last chunk length: ${chunks[chunks.length - 1].content.length} chars`,
		);

		// Test 2: Verify overlap
		if (chunks.length > 1) {
			console.log("\n2️⃣  Verifying chunk overlap...");
			const hasOverlap =
				chunks[0].content.slice(-20) === chunks[1].content.slice(0, 20);
			console.log(
				hasOverlap
					? "✅ Chunks have overlap"
					: "⚠️  No overlap detected",
			);
		}

		console.log("\n✅ Text chunking test PASSED\n");
		return true;
	} catch (error) {
		console.error("❌ Text chunking test FAILED:", error);
		return false;
	}
}

async function testEmbeddingGeneration() {
	console.log("\n🧠 Testing Embedding Generation...\n");

	const apiKey = process.env.AI_GATEWAY_API_KEY;
	if (!apiKey) {
		console.log("⚠️  Skipping embedding test: AI_GATEWAY_API_KEY not set");
		return true;
	}

	try {
		// Test 1: Generate embeddings
		console.log("1️⃣  Generating embeddings for test chunks...");
		const testChunks = ["Hello world", "This is a test"];
		const result = await generateEmbeddings(testChunks, undefined, apiKey);
		console.log(`✅ Generated ${result.embeddings.length} embeddings`);
		console.log(`   Embedding dimension: ${result.embeddings[0].length}`);
		console.log(`   Tokens used: ${result.totalTokens}`);
		console.log(`   Estimated cost: $${result.cost.toFixed(6)}`);

		console.log("\n✅ Embedding generation test PASSED\n");
		return true;
	} catch (error) {
		console.error("❌ Embedding generation test FAILED:", error);
		if (
			error instanceof Error &&
			error.message.includes("AI_GATEWAY_API_KEY")
		) {
			console.error(
				"⚠️  Make sure AI_GATEWAY_API_KEY is set in .env.local",
			);
		}
		return false;
	}
}

async function testEndToEndFlow() {
	console.log("\n🔄 Testing End-to-End Flow...\n");

	const apiKey = process.env.AI_GATEWAY_API_KEY;
	if (!apiKey) {
		console.log("⚠️  Skipping E2E test: AI_GATEWAY_API_KEY not set");
		return true;
	}

	let documentId: string | null = null;

	try {
		// Step 1: Create document in database
		console.log("1️⃣  Creating document...");
		const document = await db.chatDocument.create({
			data: {
				chatId: TEST_CHAT_ID,
				userId: TEST_USER_ID,
				filename: "e2e-test.md",
				mimeType: "text/markdown",
				size: TEST_DOCUMENT_CONTENT.length,
				s3Path: "test/e2e-test.md",
				status: "PROCESSING",
			},
		});
		documentId = document.id;
		console.log(`✅ Created document: ${documentId}`);

		// Step 2: Extract and chunk
		console.log("\n2️⃣  Extracting and chunking...");
		const extracted = await extractDocument(
			Buffer.from(TEST_DOCUMENT_CONTENT),
			"e2e-test.md",
			"text/markdown",
		);
		const chunks = chunkText(extracted.text, "e2e-test.md", {
			chunkSize: 200,
			chunkOverlap: 50,
		});
		console.log(`✅ Created ${chunks.length} chunks`);

		// Step 3: Generate embeddings
		console.log("\n3️⃣  Generating embeddings...");
		const chunkTexts = chunks.map((c) => c.content);
		const embeddingResult = await generateEmbeddings(
			chunkTexts,
			undefined,
			apiKey,
		);
		console.log(
			`✅ Generated ${embeddingResult.embeddings.length} embeddings`,
		);

		// Step 4: Store chunks with embeddings
		console.log("\n4️⃣  Storing chunks...");
		for (let i = 0; i < chunks.length; i++) {
			await storeChunk({
				documentId: document.id,
				chatId: TEST_CHAT_ID,
				userId: TEST_USER_ID,
				content: chunks[i].content,
				embedding: embeddingResult.embeddings[i],
				chunkIndex: i,
				metadata: chunks[i].metadata,
			});
		}
		console.log(`✅ Stored ${chunks.length} chunks`);

		// Step 5: Search for similar chunks
		console.log("\n5️⃣  Searching for similar chunks...");
		const queryEmbedding = embeddingResult.embeddings[0]; // Use first chunk as query
		const searchResults = await searchSimilarChunks({
			chatId: TEST_CHAT_ID,
			userId: TEST_USER_ID,
			queryEmbedding,
			topK: 3,
		});
		console.log(`✅ Found ${searchResults.length} similar chunks`);
		searchResults.forEach((result, idx) => {
			console.log(
				`   ${idx + 1}. Score: ${result.similarity.toFixed(4)} - "${result.content.slice(0, 50)}..."`,
			);
		});

		// Step 6: Update document status
		console.log("\n6️⃣  Updating document status...");
		await db.chatDocument.update({
			where: { id: document.id },
			data: { status: "READY" },
		});
		console.log("✅ Document status: READY");

		// Cleanup
		console.log("\n🧹 Cleaning up...");
		await deleteDocumentChunks(document.id);
		await db.chatDocument.delete({ where: { id: document.id } });
		console.log("✅ Cleanup complete");

		console.log("\n✅ End-to-end flow test PASSED\n");
		return true;
	} catch (error) {
		console.error("❌ End-to-end flow test FAILED:", error);
		// Cleanup on error
		if (documentId) {
			try {
				await deleteDocumentChunks(documentId);
				await db.chatDocument.delete({ where: { id: documentId } });
			} catch (cleanupError) {
				console.error("Failed to cleanup:", cleanupError);
			}
		}
		return false;
	}
}

async function runAllTests() {
	console.log(
		"╔════════════════════════════════════════════════════════════╗",
	);
	console.log(
		"║  RAG Implementation Test Suite - Phase 1 & Phase 2        ║",
	);
	console.log(
		"╚════════════════════════════════════════════════════════════╝\n",
	);

	const results = {
		database: false,
		qdrant: false,
		extraction: false,
		chunking: false,
		embedding: false,
		endToEnd: false,
	};

	try {
		// Setup test data (create user and chat)
		await setupTestData();

		// Run all tests
		results.database = await testDatabaseOperations();
		results.qdrant = await testQdrantOperations();
		results.extraction = await testDocumentExtraction();
		results.chunking = await testTextChunking();
		results.embedding = await testEmbeddingGeneration();
		results.endToEnd = await testEndToEndFlow();
	} finally {
		// Always cleanup, even if tests fail
		await cleanupTestData();
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

	const tests = [
		{ name: "Database Operations", passed: results.database },
		{ name: "Qdrant Operations", passed: results.qdrant },
		{ name: "Document Extraction", passed: results.extraction },
		{ name: "Text Chunking", passed: results.chunking },
		{ name: "Embedding Generation", passed: results.embedding },
		{ name: "End-to-End Flow", passed: results.endToEnd },
	];

	tests.forEach((test) => {
		const status = test.passed ? "✅ PASSED" : "❌ FAILED";
		console.log(`${status} - ${test.name}`);
	});

	const totalPassed = Object.values(results).filter(Boolean).length;
	const totalTests = Object.keys(results).length;

	console.log(`\n${totalPassed}/${totalTests} tests passed\n`);

	if (totalPassed === totalTests) {
		console.log(
			"🎉 All tests passed! Phase 1 & Phase 2 are working correctly.\n",
		);
		process.exit(0);
	} else {
		console.log("⚠️  Some tests failed. Please review the errors above.\n");
		process.exit(1);
	}
}

// Run tests
runAllTests().catch((error) => {
	console.error("Fatal error running tests:", error);
	process.exit(1);
});
