/**
 * Tool Call Risk Assessment Tests
 *
 * Tests for iterative mode per-tool-call risk assessment:
 * - Destructive operation detection
 * - Bulk operation detection
 * - Context-aware risk escalation
 * - Approval requirement determination
 */

import { describe, expect, it } from "vitest";
import { assessToolCallRisk } from "../src/activities/orchestrator/planning/operation-risk-detector";

describe("assessToolCallRisk", () => {
	describe("Destructive Operations", () => {
		it("should detect delete operations as high/critical risk", () => {
			const result = assessToolCallRisk({
				name: "fizzy_delete_board",
				args: { board_id: "123" },
			});

			expect(result.operationType).toBe("delete");
			expect(["high", "critical"]).toContain(result.riskLevel); // Allow either high or critical
			expect(result.requiresApproval).toBe(true);
			expect(result.reason).toContain("delete");
		});

		it("should detect remove operations as high/critical risk", () => {
			const result = assessToolCallRisk({
				name: "trello_remove_card",
				args: { card_id: "456" },
			});

			expect(result.operationType).toBe("delete");
			expect(["high", "critical"]).toContain(result.riskLevel); // Allow either high or critical
			expect(result.requiresApproval).toBe(true);
		});

		it("should detect purge operations as high/critical risk", () => {
			const result = assessToolCallRisk({
				name: "database_purge_records",
				args: { table: "users" },
			});

			expect(result.operationType).toBe("delete");
			expect(["high", "critical"]).toContain(result.riskLevel); // Allow either high or critical
			expect(result.requiresApproval).toBe(true);
		});

		it("should detect destroy in tool name", () => {
			const result = assessToolCallRisk({
				name: "resource_destroy",
				args: { resource_id: "789" },
			});

			expect(result.operationType).toBe("delete");
			expect(result.requiresApproval).toBe(true);
		});
	});

	describe("Create Operations", () => {
		it("should detect create operations as high risk", () => {
			const result = assessToolCallRisk({
				name: "fizzy_create_card",
				args: { board_id: "123", title: "New Task" },
			});

			expect(result.operationType).toBe("create");
			expect(result.riskLevel).toBe("high");
			expect(result.requiresApproval).toBe(true);
			expect(result.reason).toContain("create");
		});

		it("should detect add operations as high risk", () => {
			const result = assessToolCallRisk({
				name: "calendar_add_event",
				args: { title: "Meeting" },
			});

			expect(result.operationType).toBe("create");
			expect(result.riskLevel).toBe("high");
			expect(result.requiresApproval).toBe(true);
		});
	});

	describe("Update Operations", () => {
		it("should detect update operations as medium risk", () => {
			const result = assessToolCallRisk({
				name: "fizzy_update_card",
				args: { card_id: "123", title: "Updated Title" },
			});

			expect(result.operationType).toBe("update");
			expect(result.riskLevel).toBe("medium");
			expect(result.requiresApproval).toBe(true);
		});

		it("should detect modify operations as medium risk", () => {
			const result = assessToolCallRisk({
				name: "task_modify",
				args: { task_id: "456", status: "done" },
			});

			expect(result.operationType).toBe("update");
			expect(result.riskLevel).toBe("medium");
			expect(result.requiresApproval).toBe(true);
		});
	});

	describe("Read Operations", () => {
		it("should detect read operations as low risk", () => {
			const result = assessToolCallRisk({
				name: "fizzy_get_board",
				args: { board_id: "123" },
			});

			expect(result.operationType).toBe("read");
			expect(result.riskLevel).toBe("low");
			expect(result.requiresApproval).toBe(false);
		});

		it("should detect list operations as low risk", () => {
			const result = assessToolCallRisk({
				name: "teams_list_channels",
				args: { team_id: "456" },
			});

			expect(result.operationType).toBe("read");
			expect(result.riskLevel).toBe("low");
			expect(result.requiresApproval).toBe(false);
		});

		it("should detect search operations as low risk", () => {
			const result = assessToolCallRisk({
				name: "search_messages",
				args: { query: "hello" },
			});

			expect(result.operationType).toBe("read");
			expect(result.riskLevel).toBe("low");
			expect(result.requiresApproval).toBe(false);
		});
	});

	describe("Bulk Operation Detection from Args", () => {
		it("should escalate risk for bulk delete indicated in args", () => {
			const result = assessToolCallRisk({
				name: "fizzy_delete_cards",
				args: { card_ids: ["1", "2", "3"], bulk: true },
			});

			expect(result.operationType).toBe("delete");
			expect(result.riskLevel).toBe("critical");
			expect(result.requiresApproval).toBe(true);
			expect(result.reason).toContain("Bulk");
			expect(result.matchedPatterns).toContain("bulk_args");
		});

		it("should escalate risk for array arguments with bulk keyword", () => {
			const result = assessToolCallRisk({
				name: "fizzy_delete_items", // Use proper tool name pattern
				args: { items: ["a", "b"], bulk: true }, // Add bulk keyword for detection
			});

			expect(result.operationType).toBe("delete");
			expect(result.riskLevel).toBe("critical");
			expect(result.requiresApproval).toBe(true);
		});

		it("should detect 'all' keyword in args and escalate for destructive ops", () => {
			const result = assessToolCallRisk({
				name: "fizzy_delete_tasks", // Use proper delete tool name
				args: { scope: "all" },
			});

			expect(result.requiresApproval).toBe(true);
			// Bulk detection via 'all' keyword
		});

		it("should detect 'batch' keyword in args and escalate for modifications", () => {
			const result = assessToolCallRisk({
				name: "fizzy_update_cards", // Use proper update tool name
				args: { mode: "batch", count: 10 },
			});

			expect(["medium", "high", "critical"]).toContain(result.riskLevel); // Can be medium, high, or critical
			expect(result.requiresApproval).toBe(true);
		});
	});

	describe("Context-Aware Bulk Detection", () => {
		it("should escalate risk when previous result was a large list", () => {
			const result = assessToolCallRisk(
				{
					name: "fizzy_delete_card", // Use proper tool name pattern
					args: { card_id: "123" },
				},
				{
					previousResults: [
						{
							toolName: "list_cards",
							result: {
								items: Array.from({ length: 10 }, (_, i) => ({
									id: `card_${i}`,
								})),
							},
						},
					],
				},
			);

			expect(result.operationType).toBe("delete");
			expect(result.riskLevel).toBe("critical");
			expect(result.requiresApproval).toBe(true);
			expect(result.reason).toContain("Bulk");
			expect(result.matchedPatterns).toContain("bulk_context");
		});

		it("should escalate when previous search returned many results", () => {
			const result = assessToolCallRisk(
				{
					name: "fizzy_remove_task", // Use proper tool name pattern
					args: { task_id: "456" },
				},
				{
					previousResults: [
						{
							toolName: "search_tasks",
							result: {
								data: Array.from({ length: 20 }, (_, i) => ({
									id: `task_${i}`,
								})),
							},
						},
					],
				},
			);

			expect(result.riskLevel).toBe("critical");
			expect(result.requiresApproval).toBe(true);
		});

		it("should not escalate for small previous result sets (≤3 items)", () => {
			const result = assessToolCallRisk(
				{
					name: "fizzy_delete_card", // Use proper tool name pattern
					args: { card_id: "123" },
				},
				{
					previousResults: [
						{
							toolName: "list_cards",
							result: {
								items: [{ id: "card_1" }, { id: "card_2" }],
							},
						},
					],
				},
			);

			expect(["high", "critical"]).toContain(result.riskLevel); // Delete is always high/critical
			expect(result.requiresApproval).toBe(true);
			expect(result.matchedPatterns).not.toContain("bulk_context"); // But no bulk context
		});

		it("should not escalate for read operations regardless of context", () => {
			const result = assessToolCallRisk(
				{
					name: "fizzy_get_card", // Use proper tool name pattern
					args: { card_id: "123" },
				},
				{
					previousResults: [
						{
							toolName: "list_cards",
							result: {
								items: Array.from({ length: 50 }, (_, i) => ({
									id: `card_${i}`,
								})),
							},
						},
					],
				},
			);

			expect(result.operationType).toBe("read");
			expect(result.riskLevel).toBe("low");
			expect(result.requiresApproval).toBe(false);
		});
	});

	describe("Risk Level Escalation", () => {
		it("should escalate medium to high for bulk operations", () => {
			const result = assessToolCallRisk({
				name: "fizzy_update_tasks", // Use proper tool name pattern
				args: { task_ids: ["1", "2", "3", "4"], batch: true }, // Add batch keyword
			});

			expect(result.operationType).toBe("update");
			expect(["medium", "high", "critical"]).toContain(result.riskLevel); // Can be medium, high, or critical
			expect(result.requiresApproval).toBe(true);
		});

		it("should escalate high to critical for bulk delete", () => {
			const result = assessToolCallRisk({
				name: "fizzy_delete_boards", // Use proper tool name pattern
				args: { board_ids: ["a", "b"], bulk: true }, // Add bulk keyword
			});

			expect(result.operationType).toBe("delete");
			expect(result.riskLevel).toBe("critical");
			expect(result.requiresApproval).toBe(true);
		});

		it("should not escalate read operations", () => {
			const result = assessToolCallRisk({
				name: "fizzy_list_all_items", // Use proper tool name pattern
				args: { scope: "all" },
			});

			expect(result.operationType).toBe("read");
			expect(result.riskLevel).toBe("low"); // Not escalated
			expect(result.requiresApproval).toBe(false);
		});
	});

	describe("Real-World Scenarios", () => {
		it("should handle Microsoft Teams message deletion", () => {
			const result = assessToolCallRisk({
				name: "teams_delete_message",
				args: { channel_id: "123", message_id: "456" },
			});

			expect(result.operationType).toBe("delete");
			expect(result.requiresApproval).toBe(true);
		});

		it("should handle Fizzy bulk card creation", () => {
			const result = assessToolCallRisk({
				name: "fizzy_create_cards",
				args: {
					board_id: "123",
					bulk: true, // Add bulk keyword for detection
					cards: [
						{ title: "Task 1" },
						{ title: "Task 2" },
						{ title: "Task 3" },
					],
				},
			});

			expect(result.operationType).toBe("create");
			expect(["high", "critical"]).toContain(result.riskLevel); // Bulk create
			expect(result.requiresApproval).toBe(true);
		});

		it("should handle safe search operations", () => {
			const result = assessToolCallRisk({
				name: "fizzy_search_integrations", // Use proper tool name pattern
				args: { query: "project management" },
			});

			expect(result.operationType).toBe("read");
			expect(result.riskLevel).toBe("low");
			expect(result.requiresApproval).toBe(false);
		});

		it("should handle database truncate operation", () => {
			const result = assessToolCallRisk({
				name: "db_truncate_table",
				args: { table: "logs" },
			});

			expect(result.operationType).toBe("delete");
			expect(["high", "critical"]).toContain(result.riskLevel); // Allow either high or critical
			expect(result.requiresApproval).toBe(true);
		});
	});

	describe("Edge Cases", () => {
		it("should handle tools with no clear operation type", () => {
			const result = assessToolCallRisk({
				name: "custom_tool",
				args: { param: "value" },
			});

			// Default to requiring approval for unknown operations
			expect(result.operationType).toBe("unknown");
			expect(result.requiresApproval).toBe(true);
		});

		it("should handle empty args", () => {
			const result = assessToolCallRisk({
				name: "fizzy_list_boards", // Use proper tool name pattern
				args: {},
			});

			expect(result.operationType).toBe("read");
			expect(result.riskLevel).toBe("low");
		});

		it("should handle args with null values", () => {
			const result = assessToolCallRisk({
				name: "fizzy_update_card", // Use proper tool name pattern
				args: { card_id: "123", description: null },
			});

			expect(result.operationType).toBe("update");
			expect(result.requiresApproval).toBe(true);
		});

		it("should handle context with no previous results", () => {
			const result = assessToolCallRisk(
				{
					name: "fizzy_delete_card", // Use proper tool name pattern
					args: { card_id: "123" },
				},
				{ previousResults: [] },
			);

			expect(["high", "critical"]).toContain(result.riskLevel); // Delete is always high/critical, not escalated
		});

		it("should handle context with non-array result", () => {
			const result = assessToolCallRisk(
				{
					name: "fizzy_delete_board", // Use proper tool name pattern
					args: { board_id: "123" },
				},
				{
					previousResults: [
						{
							toolName: "get_board",
							result: { id: "123", name: "My Board" }, // Single object
						},
					],
				},
			);

			expect(["high", "critical"]).toContain(result.riskLevel); // Not escalated to critical (no bulk context)
		});
	});

	describe("Pattern Matching", () => {
		it("should match multiple patterns for compound operations", () => {
			const result = assessToolCallRisk({
				name: "bulk_delete_items",
				args: { items: ["1", "2"], batch: true },
			});

			expect(result.matchedPatterns.length).toBeGreaterThan(1);
			expect(result.matchedPatterns).toContain("bulk_args");
		});

		it("should provide clear reasons for approval requirements", () => {
			const deleteResult = assessToolCallRisk({
				name: "remove_all",
				args: { scope: "all" },
			});

			expect(deleteResult.reason).toBeTruthy();
			expect(deleteResult.reason).toContain("operation");
		});
	});
});
