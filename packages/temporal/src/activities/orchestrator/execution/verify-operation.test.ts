/**
 * Test script for the generic operation verification system.
 *
 * Run with: npx tsx packages/temporal/src/activities/orchestrator/execution/verify-operation.test.ts
 */

import type { OrchestratorStepResult } from "../../../workflows/orchestrator/types";
import type { TaskStep } from "../types";
import {
	detectOperationType,
	extractEntityType,
	extractTargetEntityName,
	isEmptyOrNotFound,
	isSpecificItemOperation,
	verifyOperation,
} from "./verify-operation";

// Helper to create a test step
function createStep(overrides: Partial<TaskStep>): TaskStep {
	return {
		id: "step_1",
		description: "Test step",
		type: "api",
		status: "complete",
		order: 1,
		...overrides,
	};
}

// Helper to create step result
function createStepResult(
	toolCalls: Array<{
		name: string;
		status: "success" | "error";
		result?: unknown;
		args?: unknown;
	}>,
	response?: string,
): OrchestratorStepResult {
	return {
		stepId: "step_1",
		stepDescription: "Test step",
		status: "complete",
		response: response || "Operation completed.",
		toolCalls: toolCalls.map((tc, i) => ({
			id: `tc_${i}`,
			name: tc.name,
			status: tc.status,
			result: tc.result,
			args: tc.args,
			durationMs: 100,
		})),
		durationMs: 1000,
	};
}

// Test cases
async function runTests() {
	console.log("🧪 Testing Generic Operation Verification System\n");
	console.log(`${"=".repeat(60)}\n`);

	// Test 1: Detect operation types
	console.log("📌 Test 1: Operation Type Detection");
	console.log("-".repeat(40));

	const opTypeTests = [
		{ desc: "Delete the 'Test 1' board", expected: "delete" },
		{ desc: "Create a new board called 'My Board'", expected: "create" },
		{ desc: "Update the board name to 'New Name'", expected: "update" },
		{ desc: "Get all boards in the workspace", expected: "read" },
		{ desc: "Find boards matching 'test'", expected: "read" },
		{ desc: "Remove all archived cards", expected: "delete" },
	];

	for (const test of opTypeTests) {
		const step = createStep({ description: test.desc });
		const opType = detectOperationType(step);
		const pass = opType === test.expected;
		console.log(
			`  ${pass ? "✅" : "❌"} "${test.desc}" → ${opType} (expected: ${test.expected})`,
		);
	}
	console.log();

	// Test 2: Extract entity type
	console.log("📌 Test 2: Entity Type Extraction");
	console.log("-".repeat(40));

	const entityTests = [
		{ text: "Delete the board", expected: "board" },
		{ text: "Create a new card", expected: "card" },
		{ text: "Update the task status", expected: "task" },
		{ text: "fizzy_delete_board", expected: "board" },
		{ text: "trello_create_card", expected: "card" },
	];

	for (const test of entityTests) {
		const entityType = extractEntityType(test.text);
		const pass = entityType === test.expected;
		console.log(
			`  ${pass ? "✅" : "❌"} "${test.text}" → ${entityType} (expected: ${test.expected})`,
		);
	}
	console.log();

	// Test 3: Extract target entity name
	console.log("📌 Test 3: Target Entity Name Extraction");
	console.log("-".repeat(40));

	const nameTests = [
		{ desc: "Delete the 'Test 1' board", expected: "Test 1" },
		{ desc: 'Delete the "My Board" board', expected: "My Board" },
		{ desc: "Find board named playground", expected: "playground" },
		{ desc: "Remove the test board", expected: "test" },
		{ desc: "Delete all boards", expected: undefined },
	];

	for (const test of nameTests) {
		const name = extractTargetEntityName(test.desc);
		const pass = name === test.expected;
		console.log(
			`  ${pass ? "✅" : "❌"} "${test.desc}" → ${name ?? "undefined"} (expected: ${test.expected ?? "undefined"})`,
		);
	}
	console.log();

	// Test 4: Empty/Not Found detection
	console.log("📌 Test 4: Empty/Not Found Detection");
	console.log("-".repeat(40));

	const emptyTests = [
		{ result: [], expected: true, label: "Empty array" },
		{
			result: { boards: [] },
			expected: true,
			label: "Object with empty boards array",
		},
		{
			result: { items: [{ id: "1" }] },
			expected: false,
			label: "Object with items",
		},
		{
			result: { found: false },
			expected: true,
			label: "Object with found: false",
		},
		{ result: { count: 0 }, expected: true, label: "Object with count: 0" },
		{
			result: "No results found",
			expected: true,
			label: "String indicating no results",
		},
		{
			result: [{ id: "1", name: "Board 1" }],
			expected: false,
			label: "Array with items",
		},
		{ result: null, expected: true, label: "null" },
	];

	for (const test of emptyTests) {
		const isEmpty = isEmptyOrNotFound(test.result);
		const pass = isEmpty === test.expected;
		console.log(
			`  ${pass ? "✅" : "❌"} ${test.label} → ${isEmpty} (expected: ${test.expected})`,
		);
	}
	console.log();

	// Test 5: Specific vs Bulk operation detection
	console.log("📌 Test 5: Specific vs Bulk Operation Detection");
	console.log("-".repeat(40));

	const specificTests = [
		{ desc: "Delete the 'Test 1' board", expected: true },
		{ desc: "Delete all boards", expected: false },
		{ desc: "Remove board named playground", expected: true },
		{ desc: "Delete every card in the list", expected: false },
		{ desc: "Update the specific task", expected: true },
	];

	for (const test of specificTests) {
		const step = createStep({ description: test.desc });
		const isSpecific = isSpecificItemOperation(step);
		const pass = isSpecific === test.expected;
		console.log(
			`  ${pass ? "✅" : "❌"} "${test.desc}" → ${isSpecific ? "specific" : "bulk"} (expected: ${test.expected ? "specific" : "bulk"})`,
		);
	}
	console.log();

	// Test 6: Full verification - "Not Found" scenario
	console.log("📌 Test 6: Verification - 'Not Found' Scenario");
	console.log("-".repeat(40));
	console.log(
		"  Scenario: User asks to delete 'Test1' but board is named 'Test 1'\n",
	);

	const notFoundStep = createStep({
		description: "Delete the 'Test1' board from Fizzy",
	});

	const notFoundResult = createStepResult(
		[
			{
				name: "fizzy_get_boards",
				status: "success",
				result: [], // Empty - board not found!
			},
		],
		"I've deleted the Test1 board successfully.", // AI falsely claims success
	);

	const notFoundVerification = await verifyOperation({
		step: notFoundStep,
		stepResult: notFoundResult,
		userId: "test_user",
	});

	console.log(
		`  Verified: ${notFoundVerification.verified ? "✅ Yes" : "❌ No"}`,
	);
	console.log(`  Operation Type: ${notFoundVerification.operationType}`);
	console.log(`  Message: ${notFoundVerification.verificationMessage}`);
	console.log(`  Should Retry: ${notFoundVerification.shouldRetry}`);
	console.log(
		`  Issues: ${notFoundVerification.details.issues.join(", ") || "None"}`,
	);
	console.log(
		`  Not Found Items: ${notFoundVerification.details.notFoundOrRemaining.length}`,
	);
	if (notFoundVerification.details.notFoundOrRemaining.length > 0) {
		for (const item of notFoundVerification.details.notFoundOrRemaining) {
			console.log(`    - ${item.name || item.type}: ${item.reason}`);
		}
	}
	console.log();

	// Test 7: Full verification - Successful delete
	console.log("📌 Test 7: Verification - Successful Delete");
	console.log("-".repeat(40));
	console.log("  Scenario: User deletes a board that exists\n");

	const successStep = createStep({
		description: "Delete the 'Test 1' board from Fizzy",
	});

	const successResult = createStepResult(
		[
			{
				name: "fizzy_get_boards",
				status: "success",
				result: [{ id: "board_123", name: "Test 1" }],
			},
			{
				name: "fizzy_delete_board",
				status: "success",
				result: { success: true },
				args: { boardId: "board_123" },
			},
		],
		"I've deleted the Test 1 board successfully.",
	);

	const successVerification = await verifyOperation({
		step: successStep,
		stepResult: successResult,
		userId: "test_user",
	});

	console.log(
		`  Verified: ${successVerification.verified ? "✅ Yes" : "❌ No"}`,
	);
	console.log(`  Operation Type: ${successVerification.operationType}`);
	console.log(`  Message: ${successVerification.verificationMessage}`);
	console.log(
		`  Success Count: ${successVerification.details.actualSuccessCount}`,
	);
	console.log(`  Fail Count: ${successVerification.details.actualFailCount}`);
	console.log();

	// Test 8: Full verification - Partial failure (bulk delete)
	console.log("📌 Test 8: Verification - Partial Bulk Delete Failure");
	console.log("-".repeat(40));
	console.log("  Scenario: Delete all boards, but some fail\n");

	const partialStep = createStep({
		description: "Delete all boards from Fizzy",
	});

	const partialResult = createStepResult(
		[
			{
				name: "fizzy_delete_board",
				status: "success",
				args: { boardId: "board_1" },
			},
			{
				name: "fizzy_delete_board",
				status: "success",
				args: { boardId: "board_2" },
			},
			{
				name: "fizzy_delete_board",
				status: "error",
				args: { boardId: "board_3" },
			},
		],
		"Deleted most boards, but some failed.",
	);

	const partialVerification = await verifyOperation({
		step: partialStep,
		stepResult: partialResult,
		userId: "test_user",
	});

	console.log(
		`  Verified: ${partialVerification.verified ? "✅ Yes" : "❌ No"}`,
	);
	console.log(`  Operation Type: ${partialVerification.operationType}`);
	console.log(`  Message: ${partialVerification.verificationMessage}`);
	console.log(
		`  Success Count: ${partialVerification.details.actualSuccessCount}`,
	);
	console.log(`  Fail Count: ${partialVerification.details.actualFailCount}`);
	console.log(`  Should Retry: ${partialVerification.shouldRetry}`);
	console.log(`  Retry Reason: ${partialVerification.retryReason || "N/A"}`);
	console.log();

	// Test 9: Create operation verification
	console.log("📌 Test 9: Verification - Create Operation");
	console.log("-".repeat(40));

	const createOpStep = createStep({
		description: "Create a new board called 'My Project'",
	});

	const createResult = createStepResult(
		[
			{
				name: "fizzy_create_board",
				status: "success",
				result: { id: "new_board_123", name: "My Project" },
			},
		],
		"Created the new board successfully.",
	);

	const createVerification = await verifyOperation({
		step: createOpStep,
		stepResult: createResult,
		userId: "test_user",
	});

	console.log(
		`  Verified: ${createVerification.verified ? "✅ Yes" : "❌ No"}`,
	);
	console.log(`  Operation Type: ${createVerification.operationType}`);
	console.log(`  Message: ${createVerification.verificationMessage}`);
	console.log();

	// Test 10: No tool calls but claimed success
	console.log("📌 Test 10: Verification - No Tool Calls (Suspicious)");
	console.log("-".repeat(40));
	console.log(
		"  Scenario: AI claims to delete but no delete tool was called\n",
	);

	const noToolStep = createStep({
		description: "Delete the 'Test' board",
	});

	const noToolResult = createStepResult(
		[], // No tool calls!
		"I've deleted the Test board for you.",
	);

	const noToolVerification = await verifyOperation({
		step: noToolStep,
		stepResult: noToolResult,
		userId: "test_user",
	});

	console.log(
		`  Verified: ${noToolVerification.verified ? "✅ Yes" : "❌ No"}`,
	);
	console.log(`  Message: ${noToolVerification.verificationMessage}`);
	console.log(
		`  Issues: ${noToolVerification.details.issues.join(", ") || "None"}`,
	);
	console.log();

	console.log("=".repeat(60));
	console.log("✅ All tests completed!\n");
}

// Run tests
runTests().catch(console.error);
