import { BUILT_IN_TO_FABRIC_TOOLS } from "@repo/database";
import { describe, expect, it } from "vitest";
import { getAllFabricAiTools } from "../../activities/orchestrator/tools/fabric-ai-tools";
import {
	AGENT_TASK_CAPABILITY_KEYS,
	agentTaskCapabilityProblem,
	describeAgentTaskCapabilities,
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

	it("refuses a capability the platform does not know, listing the ones it has", () => {
		const problem = agentTaskCapabilityProblem("telepathy");

		expect(problem).toContain(
			'"telepathy" is not a built-in capability an agent can use.',
		);
		expect(problem).toContain(
			`Use one of: ${AGENT_TASK_CAPABILITY_KEYS.join(", ")}.`,
		);
	});

	it("refuses a tool name given where a capability belongs, pointing at project-context", () => {
		const problem = agentTaskCapabilityProblem(
			"fabric_list_project_features",
		);

		expect(problem).toContain("not a built-in capability");
		expect(problem).toContain("project-context");
	});

	it("lists the capabilities when it refuses a refused one", () => {
		expect(agentTaskCapabilityProblem("web-search")).toContain(
			"Use one of: ",
		);
	});

	it("does not take an inherited object property for a capability", () => {
		expect(agentTaskCapabilityProblem("constructor")).toContain(
			"not a built-in capability",
		);
		expect(unattendedCapabilityRefusal("constructor")).toBeUndefined();
	});
});

describe("AGENT_TASK_CAPABILITY_KEYS", () => {
	it("is every capability the platform has that an unattended agent may hold", () => {
		const expected = Object.keys(BUILT_IN_TO_FABRIC_TOOLS).filter(
			(capability) =>
				unattendedCapabilityRefusal(capability) === undefined,
		);

		expect([...AGENT_TASK_CAPABILITY_KEYS]).toEqual(expected);
	});

	it("passes the check that refuses everything else", () => {
		const problems = AGENT_TASK_CAPABILITY_KEYS.filter(
			(capability) =>
				agentTaskCapabilityProblem(capability) !== undefined,
		);

		expect(problems).toEqual([]);
	});

	it("includes project-context and leaves out every refused capability", () => {
		expect(AGENT_TASK_CAPABILITY_KEYS).toContain("project-context");
		expect(AGENT_TASK_CAPABILITY_KEYS).not.toContain("web-search");
		expect(AGENT_TASK_CAPABILITY_KEYS).not.toContain("create-frames");
	});

	it("says what project-context grants, and describes every key", () => {
		const description = describeAgentTaskCapabilities();

		expect(description).toContain(
			"project-context (read this project's roadmap, documents, sources and meetings)",
		);
		for (const capability of AGENT_TASK_CAPABILITY_KEYS) {
			expect(description).toMatch(new RegExp(`${capability} \\(`));
		}
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
