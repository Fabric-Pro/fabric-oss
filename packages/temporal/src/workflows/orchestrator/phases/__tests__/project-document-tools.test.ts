/**
 * Orchestrator wiring for the live document and Context-tab source reads
 * (Fizzy #2578).
 *
 * The iterative loop pre-registers the four tools when a project is attached,
 * behind `orch-project-document-tools-v1`, and pins them to the virtual Fabric
 * config id so `executeMcpTool` hands them to the catalog adapter instead of
 * searching the user's MCP servers. They add no dispatch arm, so no call that
 * a recorded history made is routed differently. Read from source: the
 * workflow module is not importable outside the Temporal sandbox.
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
import { PROJECT_DOCUMENT_TOOL_IDS } from "../../../../activities/shared/project-document-reads";
import {
	PROJECT_DOCUMENT_GET_INPUT_SCHEMA,
	PROJECT_DOCUMENT_LIST_INPUT_SCHEMA,
	PROJECT_RAG_QUERY_LISTING_HINT,
	PROJECT_SOURCE_GET_INPUT_SCHEMA,
	PROJECT_SOURCE_LIST_INPUT_SCHEMA,
} from "../../project-document-tool-schemas";
import { assessToolCallRisk } from "../../risk-assessment";

const loop = readFileSync(join(__dirname, "../iterative-execution.ts"), "utf8");
const NAMES = [...PROJECT_DOCUMENT_TOOL_IDS];
const SCHEMAS = {
	fabric_list_project_documents: PROJECT_DOCUMENT_LIST_INPUT_SCHEMA,
	fabric_get_project_document: PROJECT_DOCUMENT_GET_INPUT_SCHEMA,
	fabric_list_project_sources: PROJECT_SOURCE_LIST_INPUT_SCHEMA,
	fabric_get_project_source: PROJECT_SOURCE_GET_INPUT_SCHEMA,
};

describe("iterative loop pre-registration", () => {
	const gateStart = loop.indexOf(
		'if (patched("orch-project-document-tools-v1"))',
	);
	const gated = loop.slice(gateStart, loop.indexOf("\n\t\t}\n", gateStart));

	it("sits behind its own patch marker, inside the attached-project block", () => {
		expect(gateStart).toBeGreaterThan(-1);
		const projectBlock = loop.lastIndexOf(
			"if (input.projectId) {",
			gateStart,
		);
		expect(loop.slice(projectBlock, gateStart)).toContain(
			"discoveredTools.project_rag_query = {",
		);
	});

	it("registers all four tools and routes them to the Fabric catalog config", () => {
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

	it("points project_rag_query at the listings only when they are registered", () => {
		expect(gated).toContain("PROJECT_RAG_QUERY_LISTING_HINT");
		expect(loop.replace(gated, "")).not.toMatch(
			/description[^;]*PROJECT_RAG_QUERY_LISTING_HINT/,
		);
	});

	it("lists them as pre-attached only when they were registered", () => {
		expect(loop).toMatch(
			/\$\{projectDocumentToolsRegistered \? "fabric_list_project_documents, fabric_get_project_document, fabric_list_project_sources, fabric_get_project_source, " : ""\}/,
		);
	});

	it("adds no dispatch arm of its own", () => {
		for (const name of NAMES) {
			expect(loop).not.toContain(`toolCall.name === "${name}"`);
		}
	});
});

describe("catalog routing", () => {
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
		for (const name of NAMES) {
			expect(byName.get(name)?.inputSchema).toBe(SCHEMAS[name]);
		}
	});

	it("tells project_rag_query to leave inventories to the list tools", () => {
		const rag = getFabricAiTools().find(
			(t) => t.name === "project_rag_query",
		);
		expect(rag?.description).toContain(PROJECT_RAG_QUERY_LISTING_HINT);
		expect(PROJECT_RAG_QUERY_LISTING_HINT).toContain(
			"fabric_list_project_documents",
		);
		expect(PROJECT_RAG_QUERY_LISTING_HINT).toContain(
			"fabric_list_project_sources",
		);
	});

	it("never lets the model choose the project or tenant", () => {
		for (const schema of Object.values(SCHEMAS)) {
			expect(Object.keys(schema.properties)).not.toContain("projectId");
			expect(Object.keys(schema.properties)).not.toContain(
				"organizationId",
			);
		}
	});

	it("does not reuse the MCP gateway's tool names", () => {
		for (const gatewayName of [
			"fabric_list_documents",
			"fabric_get_document",
			"fabric_list_project_contexts",
			"fabric_get_project_context",
		]) {
			expect(NAMES).not.toContain(gatewayName);
		}
	});
});

describe("classified as reads everywhere a gate looks", () => {
	it.each(NAMES)("%s is READ to the authority classifier", (name) => {
		expect(classifyToolAccessLevel(name)).toBe("READ");
	});

	it.each([
		["fabric_list_project_documents", { search: "remove all" }],
		["fabric_get_project_source", { source: "c-1" }],
	] as const)(
		"%s needs no risk approval when routed to Fabric",
		(name, args) => {
			expect(
				assessToolCallRisk({ name, args }, "CONSERVATIVE", {
					rules: "read-only-exempt-v1",
					fabricRouted: true,
				}).requiresApproval,
			).toBe(false);
		},
	);
});
