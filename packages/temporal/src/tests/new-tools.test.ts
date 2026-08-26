/**
 * Tests for new Fabric AI tools:
 * - fabric_text_to_speech
 * - fabric_create_frame
 * - fabric_update_frame
 * - fabric_get_frame
 * - fabric_list_frames
 * - fabric_share_frame
 * - fabric_create_slideshow
 * - fabric_asana_create_task
 * - fabric_asana_list_tasks
 * - fabric_attio_create_record
 * - fabric_attio_search_records
 * - fabric_front_create_conversation
 * - fabric_front_list_conversations
 */

import { describe, expect, it } from "vitest";
import {
	getAllFabricAiTools,
	getFabricAiTools,
} from "../activities/orchestrator/tools/fabric-ai-tools";

describe("Fabric AI Tools - New Tools Registration", () => {
	it("should include fabric_text_to_speech in visible tools", () => {
		const tools = getFabricAiTools();
		const tool = tools.find((t) => t.name === "fabric_text_to_speech");
		expect(tool).toBeDefined();
		expect(tool?.inputSchema).toBeDefined();
		expect(tool?.outputSchema).toBeDefined();
	});

	it("fabric_text_to_speech should have voice enum options", () => {
		const tools = getFabricAiTools();
		const tool = tools.find((t) => t.name === "fabric_text_to_speech");
		const schema = tool?.inputSchema as {
			properties: {
				voice?: { enum: string[] };
				text?: unknown;
			};
			required: string[];
		};
		expect(schema.properties.voice?.enum).toEqual([
			"alloy",
			"echo",
			"fable",
			"onyx",
			"nova",
			"shimmer",
		]);
		expect(schema.required).toContain("text");
	});

	it("should include fabric_create_frame in visible tools", () => {
		const tools = getFabricAiTools();
		const tool = tools.find((t) => t.name === "fabric_create_frame");
		expect(tool).toBeDefined();
		expect(tool?.inputSchema).toBeDefined();
		expect(tool?.outputSchema).toBeDefined();
	});

	it("fabric_create_frame should support html, json, mermaid formats", () => {
		const tools = getFabricAiTools();
		const tool = tools.find((t) => t.name === "fabric_create_frame");
		const schema = tool?.inputSchema as {
			properties: {
				format?: { enum: string[] };
				title?: unknown;
			};
			required: string[];
		};
		expect(schema.properties.format?.enum).toContain("html");
		expect(schema.properties.format?.enum).toContain("json");
		expect(schema.properties.format?.enum).toContain("mermaid");
		expect(schema.required).toContain("title");
	});

	it("should include the first-class frame tool family", () => {
		const tools = getFabricAiTools();
		for (const name of [
			"fabric_update_frame",
			"fabric_get_frame",
			"fabric_list_frames",
			"fabric_share_frame",
			"fabric_create_slideshow",
		]) {
			expect(tools.find((t) => t.name === name)).toBeDefined();
		}
	});

	describe("Third-party integration tools", () => {
		it("should include Asana tools", () => {
			const tools = getFabricAiTools();
			expect(
				tools.find((t) => t.name === "fabric_asana_create_task"),
			).toBeDefined();
			expect(
				tools.find((t) => t.name === "fabric_asana_list_tasks"),
			).toBeDefined();
		});

		it("should include Attio tools", () => {
			const tools = getFabricAiTools();
			expect(
				tools.find((t) => t.name === "fabric_attio_create_record"),
			).toBeDefined();
			expect(
				tools.find((t) => t.name === "fabric_attio_search_records"),
			).toBeDefined();
		});

		it("should include Front tools", () => {
			const tools = getFabricAiTools();
			expect(
				tools.find(
					(t) => t.name === "fabric_front_create_conversation",
				),
			).toBeDefined();
			expect(
				tools.find((t) => t.name === "fabric_front_list_conversations"),
			).toBeDefined();
		});

		it("fabric_asana_create_task should require task name", () => {
			const tools = getFabricAiTools();
			const tool = tools.find(
				(t) => t.name === "fabric_asana_create_task",
			);
			const schema = tool?.inputSchema as { required: string[] };
			expect(schema.required).toContain("name");
		});

		it("fabric_attio_create_record should require objectType and attributes", () => {
			const tools = getFabricAiTools();
			const tool = tools.find(
				(t) => t.name === "fabric_attio_create_record",
			);
			const schema = tool?.inputSchema as { required: string[] };
			expect(schema.required).toContain("objectType");
			expect(schema.required).toContain("attributes");
		});

		it("fabric_front_create_conversation should require subject, body, to", () => {
			const tools = getFabricAiTools();
			const tool = tools.find(
				(t) => t.name === "fabric_front_create_conversation",
			);
			const schema = tool?.inputSchema as { required: string[] };
			expect(schema.required).toContain("subject");
			expect(schema.required).toContain("body");
			expect(schema.required).toContain("to");
		});
	});

	describe("Hidden tools remain hidden", () => {
		it("fabric_mcp_list should be hidden from visible tools but in all tools", () => {
			const visibleTools = getFabricAiTools();
			const allTools = getAllFabricAiTools();
			expect(
				visibleTools.find((t) => t.name === "fabric_mcp_list"),
			).toBeUndefined();
			expect(
				allTools.find((t) => t.name === "fabric_mcp_list"),
			).toBeDefined();
		});
	});

	describe("All new tools have descriptions", () => {
		const newToolNames = [
			"fabric_text_to_speech",
			"fabric_create_frame",
			"fabric_update_frame",
			"fabric_get_frame",
			"fabric_list_frames",
			"fabric_share_frame",
			"fabric_create_slideshow",
			"fabric_asana_create_task",
			"fabric_asana_list_tasks",
			"fabric_attio_create_record",
			"fabric_attio_search_records",
			"fabric_front_create_conversation",
			"fabric_front_list_conversations",
		];

		for (const toolName of newToolNames) {
			it(`${toolName} should have a description`, () => {
				const tools = getFabricAiTools();
				const tool = tools.find((t) => t.name === toolName);
				expect(tool?.description).toBeTruthy();
				expect(tool?.description?.length).toBeGreaterThan(20);
			});
		}
	});
});
