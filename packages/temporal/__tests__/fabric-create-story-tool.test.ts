import { BUILT_IN_TO_FABRIC_TOOLS } from "@repo/database";
import { describe, expect, it } from "vitest";
import { getAllFabricAiTools } from "../src/activities/orchestrator/tools/fabric-ai-tools";

describe("fabric_create_story tool wiring", () => {
	const tool = getAllFabricAiTools().find(
		(t) => t.name === "fabric_create_story",
	);

	it("is registered as a Fabric AI tool", () => {
		expect(tool).toBeDefined();
	});

	it("requires only request; title and kind are optional", () => {
		const schema = tool?.inputSchema as
			| {
					type: string;
					properties: Record<
						string,
						{ type: string; enum?: string[]; description?: string }
					>;
					required?: string[];
			  }
			| undefined;

		expect(schema?.type).toBe("object");
		// `title` was previously required; now server-generated when absent.
		// `kind` was previously required; F-171 makes it an optional hint —
		// the classifier in `createStoryFromProposal` is the source of truth.
		expect(schema?.required).toEqual(expect.arrayContaining(["request"]));
		expect(schema?.required).not.toContain("title");
		expect(schema?.required).not.toContain("kind");
		// The title prop is still declared for callers that supply one.
		expect(schema?.properties.title?.type).toBe("string");
		expect(schema?.properties.title?.description?.toLowerCase()).toContain(
			"optional",
		);
		expect(schema?.properties.kind?.enum).toEqual(["FEATURE", "BUG"]);
		expect(schema?.properties.priority?.enum).toEqual([
			"P0_CRITICAL",
			"P1_HIGH",
			"P2_MEDIUM",
			"P3_LOW",
		]);
		expect(schema?.properties.size?.enum).toEqual([
			"XS",
			"S",
			"M",
			"L",
			"XL",
		]);
	});

	it("description signals that title is auto-generated when absent", () => {
		expect(tool?.description?.toLowerCase()).toContain(
			"generated automatically",
		);
	});

	it("declares the output fields the agent will reference in replies", () => {
		const schema = tool?.outputSchema as
			| { properties: Record<string, unknown> }
			| undefined;

		const props = schema?.properties ?? {};
		for (const field of [
			"storyId",
			"identifier",
			"title",
			"kind",
			"url",
			"aiDrafted",
		]) {
			expect(props).toHaveProperty(field);
		}
	});

	it("is reachable via the create-story built-in capability key", () => {
		expect(BUILT_IN_TO_FABRIC_TOOLS["create-story"]).toEqual([
			"fabric_create_story",
		]);
	});
});
