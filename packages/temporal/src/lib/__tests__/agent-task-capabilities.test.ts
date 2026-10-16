import { BUILT_IN_TO_FABRIC_TOOLS } from "@repo/database";
import { describe, expect, it } from "vitest";
import { getAllFabricAiTools } from "../../activities/orchestrator/tools/fabric-ai-tools";
import {
	agentTaskCapabilityProblem,
	unattendedCapabilityRefusal,
} from "../agent-task-capabilities";

/** A parameter name or format that takes an address the caller chooses. */
const ADDRESS_PARAMETER = /url|uri|href|link|endpoint|webhook|host/i;

/**
 * Address-shaped parameters a person has reviewed and found are only stored,
 * never requested. Adding to this list is the decision that a parameter cannot
 * carry data to a server of the caller's choosing.
 */
const STORED_NOT_FETCHED: ReadonlySet<string> = new Set([
	"fabric_create_story.reporterSourceUrl",
]);

function addressParameters(
	toolId: string,
	inputSchema: Record<string, unknown> | undefined,
) {
	const properties = inputSchema?.properties;
	if (!properties || typeof properties !== "object") {
		return [];
	}
	return Object.entries(properties).filter(([name, schema]) => {
		const format =
			schema && typeof schema === "object" && "format" in schema
				? String(schema.format)
				: "";
		return (
			(ADDRESS_PARAMETER.test(name) || format === "uri") &&
			!STORED_NOT_FETCHED.has(`${toolId}.${name}`)
		);
	});
}

describe("agentTaskCapabilityProblem", () => {
	it.each([
		"web-search",
		"web-search-browse",
		"code-interpreter",
		"create-frames",
		"run-agent",
	])("refuses %s, naming the capability and why", (capability) => {
		const problem = agentTaskCapabilityProblem(capability);

		expect(problem).toContain(`"${capability}"`);
		expect(problem).toContain("not allowed");
	});

	it("explains that the web capabilities reach addresses the agent chooses", () => {
		expect(agentTaskCapabilityProblem("web-search")).toContain(
			"addresses of its own choosing",
		);
	});

	it("lets an agent read the project", () => {
		expect(agentTaskCapabilityProblem("project-context")).toBeUndefined();
	});

	it("refuses a capability the platform does not know", () => {
		expect(agentTaskCapabilityProblem("telepathy")).toBe(
			'"telepathy" is not a built-in capability an agent can use.',
		);
	});

	it("does not take an inherited object property for a capability", () => {
		expect(agentTaskCapabilityProblem("constructor")).toContain(
			"not a built-in capability",
		);
		expect(unattendedCapabilityRefusal("constructor")).toBeUndefined();
	});
});

describe("capabilities that reach an address of the caller's choosing", () => {
	const definitions = new Map(
		getAllFabricAiTools().map((tool) => [tool.name, tool]),
	);

	it("are all refused for an unattended agent", () => {
		const offenders = Object.entries(BUILT_IN_TO_FABRIC_TOOLS).flatMap(
			([capability, toolIds]) =>
				unattendedCapabilityRefusal(capability) === undefined
					? toolIds
							.filter(
								(toolId) =>
									addressParameters(
										toolId,
										definitions.get(toolId)?.inputSchema,
									).length > 0,
							)
							.map((toolId) => `${capability} -> ${toolId}`)
					: [],
		);

		expect(offenders).toEqual([]);
	});

	it("includes the tools that scrape a page, so the scan has something to find", () => {
		const scrape = definitions.get("fabric_scrape_url");

		const found = addressParameters(
			"fabric_scrape_url",
			scrape?.inputSchema,
		);

		expect(found.map(([name]) => name)).toEqual(["url"]);
	});
});
