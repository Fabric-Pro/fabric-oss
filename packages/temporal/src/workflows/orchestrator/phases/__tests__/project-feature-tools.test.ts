/**
 * Orchestrator wiring for the live roadmap reads (Fizzy #2309/#2310).
 *
 * The iterative loop pre-registers `fabric_list_project_features` and
 * `fabric_get_project_feature` when a project is attached, behind
 * `orch-project-feature-tools-v1`, and pins them to the virtual Fabric config
 * id so `executeMcpTool` hands them to the catalog adapter instead of
 * searching the user's MCP servers. Read from source: the workflow module is
 * not importable outside the Temporal sandbox for an invariant check.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyToolAccessLevel } from "../../../../activities/orchestrator/execution/authority-gate";
import {
	fabricCatalogAuthority,
	resolveFabricCatalogRoute,
} from "../../../../activities/orchestrator/execution/fabric-catalog-adapter";
import { getFabricAiTools } from "../../../../activities/orchestrator/tools/fabric-ai-tools";
import { jsonSchemaToZod } from "../../../../activities/orchestrator/utils/schema-utils";
import {
	PROJECT_FEATURE_GET_DESCRIPTION,
	PROJECT_FEATURE_GET_INPUT_SCHEMA,
	PROJECT_FEATURE_LIST_INPUT_SCHEMA,
} from "../../project-feature-tool-schemas";
import { assessToolCallRisk } from "../../risk-assessment";

const loop = readFileSync(join(__dirname, "../iterative-execution.ts"), "utf8");
const NAMES = ["fabric_list_project_features", "fabric_get_project_feature"];

describe("iterative loop pre-registration", () => {
	const gateStart = loop.indexOf(
		'if (patched("orch-project-feature-tools-v1"))',
	);
	const gated = loop.slice(gateStart, loop.indexOf("\n\t\t}\n", gateStart));

	it("sits behind its own patch marker, inside the attached-project block", () => {
		expect(gateStart).toBeGreaterThan(-1);
		const projectBlock = loop.lastIndexOf(
			"if (input.projectId) {",
			gateStart,
		);
		expect(projectBlock).toBeGreaterThan(-1);
		expect(loop.slice(projectBlock, gateStart)).toContain(
			"discoveredTools.fabric_list_meeting_transcripts",
		);
	});

	it("registers both tools and routes them to the Fabric catalog config", () => {
		for (const name of NAMES) {
			expect(gated).toContain(`discoveredTools.${name} = {`);
			expect(gated).toMatch(
				new RegExp(
					`discoveredToolConfigIds\\.${name} =\\s*"fabric-ai-server"`,
				),
			);
		}
	});

	it("never registers them outside the patch gate", () => {
		const outside = loop.replace(gated, "");
		for (const name of NAMES) {
			expect(outside).not.toContain(`discoveredTools.${name} =`);
		}
	});

	it("lists them as pre-attached only when they were registered", () => {
		expect(loop).toMatch(
			/\$\{projectFeatureToolsRegistered \? "fabric_list_project_features, fabric_get_project_feature, " : ""\}/,
		);
	});
});

describe("catalog routing", () => {
	it("advertises updated sorting in the shared Advisor catalog schema", () => {
		const schema = getFabricAiTools().find(
			(t) => t.name === "fabric_list_project_features",
		)?.inputSchema as { properties: Record<string, unknown> };
		expect(jsonSchemaToZod(schema).parse({ sort: "updated" })).toEqual({
			sort: "updated",
		});
		expect(schema.properties.sort).toMatchObject({
			enum: ["identifier", "updated"],
			default: "identifier",
		});
	});

	it.each(NAMES)(
		"%s runs in-process as a READ with no integration authority",
		(name) => {
			expect(resolveFabricCatalogRoute(name)).toEqual({
				executor: "direct-builder",
				access: "READ",
			});
			expect(fabricCatalogAuthority(name)).toEqual({ kind: "fabric" });
		},
	);

	it("shares one input schema between the catalog and the loop", () => {
		const byName = new Map(getFabricAiTools().map((t) => [t.name, t]));
		expect(byName.get("fabric_list_project_features")?.inputSchema).toBe(
			PROJECT_FEATURE_LIST_INPUT_SCHEMA,
		);
		expect(byName.get("fabric_get_project_feature")?.inputSchema).toBe(
			PROJECT_FEATURE_GET_INPUT_SCHEMA,
		);
	});

	it("never lets the model choose the project or tenant", () => {
		for (const schema of [
			PROJECT_FEATURE_LIST_INPUT_SCHEMA,
			PROJECT_FEATURE_GET_INPUT_SCHEMA,
		]) {
			expect(Object.keys(schema.properties)).not.toContain("projectId");
			expect(Object.keys(schema.properties)).not.toContain(
				"organizationId",
			);
		}
	});
});

// A roadmap read must never stop the loop for approval or ask for write
// authority — otherwise every "what is In Review?" becomes a prompt.
describe("classified as reads everywhere a gate looks", () => {
	it.each(NAMES)("%s is READ to the authority classifier", (name) => {
		expect(classifyToolAccessLevel(name)).toBe("READ");
	});

	it.each([
		["fabric_list_project_features", { status: "In Review", limit: 25 }],
		["fabric_get_project_feature", { feature: "F-040" }],
	] as const)("%s needs no risk approval", (name, args) => {
		expect(assessToolCallRisk({ name, args }).requiresApproval).toBe(false);
	});
});

describe("feature detail paging patch compatibility", () => {
	it.each([false, true])(
		"sends the expected feature definition with paging marker=%s",
		(enabled) => {
			const legacy = JSON.parse(
				readFileSync(
					join(
						__dirname,
						"fixtures/project-feature-detail-legacy.json",
					),
					"utf8",
				),
			);
			const constants = {
				PROJECT_FEATURE_LIST_DESCRIPTION: "list",
				PROJECT_FEATURE_LIST_INPUT_SCHEMA,
				PROJECT_FEATURE_GET_DESCRIPTION,
				PROJECT_FEATURE_GET_INPUT_SCHEMA,
				LEGACY_PROJECT_FEATURE_GET_DESCRIPTION: legacy.description,
				LEGACY_PROJECT_FEATURE_GET_INPUT_SCHEMA: legacy.inputSchema,
			};
			const start = loop.indexOf(
				'if (patched("orch-project-feature-tools-v1"))',
			);
			const registration = loop.slice(
				start,
				loop.indexOf("\n\t\t}\n", start) + 4,
			);
			const calls: string[] = [];
			const execute = new Function(
				...Object.keys(constants),
				"patched",
				"const discoveredTools={}; const discoveredToolConfigIds={}; let projectFeatureToolsRegistered=false;" +
					registration +
					";return discoveredTools;",
			);
			const registered = execute(
				...Object.values(constants),
				(id: string) => {
					calls.push(id);
					return id === "orch-project-feature-tools-v1" || enabled;
				},
			);
			expect(calls).toContain("orch-project-feature-detail-paging-v1");
			const definition = registered.fabric_get_project_feature;
			if (enabled) {
				expect(definition.inputSchema.properties.section.enum).toEqual([
					"description",
					"acceptanceCriteria",
					"tasks",
				]);
				expect(definition.inputSchema.properties.offset).toMatchObject({
					type: "integer",
					minimum: 0,
				});
				expect(definition.description).toContain("truncations[].next");
			} else {
				expect(JSON.stringify(definition)).toBe(JSON.stringify(legacy));
			}
		},
	);

	it("advertises paging in the shared Direct/catalog definition", () => {
		const definition = getFabricAiTools().find(
			(t) => t.name === "fabric_get_project_feature",
		);
		if (!definition?.inputSchema) {
			throw new Error("Missing feature detail schema");
		}
		const parse = jsonSchemaToZod(definition.inputSchema);
		expect(
			parse.parse({ feature: "F-040", section: "tasks", offset: 3 }),
		).toEqual({ feature: "F-040", section: "tasks", offset: 3 });
		expect(definition.description).toContain("truncations[].next");
	});
});
