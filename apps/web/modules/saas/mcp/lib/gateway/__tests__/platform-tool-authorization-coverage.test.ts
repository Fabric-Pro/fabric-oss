/**
 * A platform tool that writes asks a permission question, not a visibility one
 * (Fizzy #2380).
 *
 * Three handlers reached a write having asked only `hasProjectAccess` — "may
 * this caller see the project" — or nothing at all, and nothing noticed for as
 * long as they existed. The repo's own coverage guard
 * (`packages/api/__tests__/permission-coverage.test.ts`) could not have caught
 * them: it scans `packages/api/modules/**` for files containing `.handler(`,
 * and these are plain `async function handleX(args, session)` in one
 * 4,000-line file in `apps/web`.
 *
 * The distinction this guard draws is the one that was missed. A visibility
 * check *is* a gate — that is exactly why "does this handler have a gate?"
 * would have passed all three. So writes are held to a stricter list: they must
 * consult something that resolves the caller's *role*, not merely their sight
 * of the resource.
 *
 * It scans per handler rather than per file, because file-level granularity
 * means nothing when all 42 live in one module — a single `canEditProject`
 * anywhere in it would vouch for the lot.
 *
 * What it cannot do is tell you the gate is the *right* one; a reviewer still
 * has to check that a story write asks about stories. It only guarantees that
 * the question asked was about permission.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FABRIC_PROJECT_PM_TOOL_DEFINITIONS } from "@repo/temporal/fabric-project-pm-tool-definitions";
import { describe, expect, it } from "vitest";
import { PLATFORM_TOOL_DEFINITIONS } from "../platform-tools";
import {
	PROJECT_BOUND_HIDDEN_TOOL_NAMES,
	PROJECT_BOUND_TOOL_NAMES,
} from "../project-binding";

// Resolved from the vitest root (`apps/web`) rather than from `import.meta.url`,
// which this runner does not give as a file URL.
const GATEWAY_DIRECTORY = "modules/saas/mcp/lib/gateway";
const PM_FAMILY_SOURCE = readFileSync(
	resolve(process.cwd(), GATEWAY_DIRECTORY, "tools/project-pm-tools.ts"),
	"utf8",
);
const PM_HANDLER_BODY =
	PM_FAMILY_SOURCE.match(
		/handlers\.set\(tool\.name, async \(args, session\) => \{([\s\S]*?)\n\t\t\}\);/,
	)?.[1] ?? "";

const CONTEXT_QUALITY_FAMILY_SOURCE = readFileSync(
	resolve(process.cwd(), GATEWAY_DIRECTORY, "tools/context-quality-tools.ts"),
	"utf8",
);

// This is an explicit proof for this injected factory, not permission credit
// for arbitrary functions named authorize. The wiring and both guarded calls
// are verified below before these bodies participate in the coverage scan.
const CONTEXT_QUALITY_HANDLERS = [
	["fabric_inspect_context_quality_source", "inspectContextQualitySource"],
	["fabric_evaluate_context_quality", "evaluateProjectContext"],
].map(([tool, command]) => ({
	tool,
	command,
	name: handlerOf(tool),
	body:
		CONTEXT_QUALITY_FAMILY_SOURCE.match(
			new RegExp(
				`handlers\\.set\\(\\s*"${tool}",\\s*async \\(args, session\\) => \\{([\\s\\S]*?)\\n\\t{1,2}\\},?\\s*\\);`,
			),
		)?.[1] ?? "",
}));

const SAVED_CONTEXT_QUALITY_HANDLER_BODY =
	CONTEXT_QUALITY_FAMILY_SOURCE.match(
		/handlers\.set\(name, async \(args, session\) => \{([\s\S]*?)\n\t\t\}\);/,
	)?.[1] ?? "";
const SAVED_CONTEXT_QUALITY_TOOLS = [
	"fabric_context_quality_run_capabilities",
	"fabric_create_context_quality_run",
	"fabric_list_context_quality_runs",
	"fabric_get_context_quality_run",
	"fabric_cancel_context_quality_run",
	"fabric_compare_context_quality_runs",
] as const;

const AGENT_RESULT_QUALITY_FAMILY_SOURCE = readFileSync(
	resolve(
		process.cwd(),
		GATEWAY_DIRECTORY,
		"tools/agent-result-quality-tools.ts",
	),
	"utf8",
);
const AGENT_RESULT_QUALITY_HANDLER_BODY =
	AGENT_RESULT_QUALITY_FAMILY_SOURCE.match(
		/handlers\.set\(name, async \(raw, session\) => \{([\s\S]*?)\n\t\t\}\);/,
	)?.[1] ?? "";
const AGENT_RESULT_QUALITY_TOOLS = [
	"fabric_inspect_agent_run_result",
	"fabric_check_agent_run_result",
] as const;

const CONTEXT_SELECTION_FAMILY_SOURCE = readFileSync(
	resolve(
		process.cwd(),
		GATEWAY_DIRECTORY,
		"tools/context-selection-tools.ts",
	),
	"utf8",
);
const CONTEXT_SELECTION_HANDLER_BODY =
	CONTEXT_SELECTION_FAMILY_SOURCE.match(
		/const handler: PlatformToolHandler = async \(args, session\) => \{([\s\S]*?)\n\t\};/,
	)?.[1] ?? "";
const CONTEXT_SELECTION_TOOLS = ["fabric_assemble_project_context"] as const;

const WORKSPACE_DOCUMENT_LINK_FAMILY_SOURCE = readFileSync(
	resolve(
		process.cwd(),
		GATEWAY_DIRECTORY,
		"tools/workspace-document-link-tools.ts",
	),
	"utf8",
);
const WORKSPACE_DOCUMENT_LINK_HANDLER_BODY =
	WORKSPACE_DOCUMENT_LINK_FAMILY_SOURCE.match(
		/handlers\.set\(name, async \(args, session\) => \{([\s\S]*?)\n\t\t\}\);/,
	)?.[1] ?? "";
const WORKSPACE_DOCUMENT_LINK_TOOLS = [
	"fabric_list_project_workspace_documents",
	"fabric_read_project_workspace_document",
	"fabric_link_workspace_document",
	"fabric_unlink_workspace_document",
] as const;

const AGENT_RUN_FAMILY_SOURCE = readFileSync(
	resolve(process.cwd(), GATEWAY_DIRECTORY, "tools/agent-run-tools.ts"),
	"utf8",
);
const AGENT_RUN_HANDLER_BODY =
	AGENT_RUN_FAMILY_SOURCE.match(
		/handlers\.set\(name, async \(args, session\) => \{([\s\S]*?)\n\t\t\}\);/,
	)?.[1] ?? "";
const AGENT_RUN_TOOLS = [
	"fabric_search_agent_runs",
	"fabric_list_agent_runs",
	"fabric_get_agent_run",
	"fabric_cancel_agent_run",
	"fabric_get_agent_run_schedule",
	"fabric_set_agent_run_schedule",
] as const;

function handlerOf(tool: string): string {
	return `handle${tool
		.replace(/^fabric_/, "")
		.split("_")
		.map((word) => word[0].toUpperCase() + word.slice(1))
		.join("")}`;
}

// The handlers of the platform table: its own file, and the modules whose tools
// it registers (`./tools`), which each carry their handlers beside their
// definitions.
const SOURCES = [
	resolve(process.cwd(), GATEWAY_DIRECTORY, "platform-tools.ts"),
	resolve(process.cwd(), GATEWAY_DIRECTORY, "memory-write-tools.ts"),
	resolve(process.cwd(), GATEWAY_DIRECTORY, "knowledge-tools.ts"),
	resolve(process.cwd(), GATEWAY_DIRECTORY, "rules-tools.ts"),
	resolve(process.cwd(), GATEWAY_DIRECTORY, "code-repositories-tools.ts"),
	resolve(process.cwd(), GATEWAY_DIRECTORY, "instruction-set-tools.ts"),
	resolve(process.cwd(), GATEWAY_DIRECTORY, "project-rag-tools.ts"),
	resolve(process.cwd(), GATEWAY_DIRECTORY, "tools/frame-tools.ts"),
	resolve(process.cwd(), GATEWAY_DIRECTORY, "tools/frame-version-tools.ts"),
	resolve(process.cwd(), GATEWAY_DIRECTORY, "tools/page-tools.ts"),
	resolve(process.cwd(), GATEWAY_DIRECTORY, "tools/page-data-tools.ts"),
	resolve(process.cwd(), GATEWAY_DIRECTORY, "tools/page-file-tools.ts"),
	resolve(process.cwd(), GATEWAY_DIRECTORY, "tools/page-comment-tools.ts"),
	resolve(process.cwd(), GATEWAY_DIRECTORY, "tools/page-ask-tool.ts"),
	resolve(process.cwd(), GATEWAY_DIRECTORY, "tools/report-tools.ts"),
];

/** Resolves what the caller may *do*. */
const PERMISSION_GATES = [
	"canEditProject",
	"canUpdateProjectStory",
	"canCreateProjectStory",
	"canCreateProjectInOrganization",
	"resolveGatewayProjectWriteAccess",
	"resolveProjectForStoryWrite",
	"isOrganizationMember",
	"session.credential",
] as const;

/** Resolves what the caller may *see*. Enough for a read, never for a write. */
const VISIBILITY_GATES = [
	"hasGatewayProjectAccess",
	"resolveGatewayProjectReadAccess",
	"resolveGatewayWorkspaceReadAccess",
	"tenantFilter(",
	"session.organizationId",
	// Opens a page as the caller, in the caller's organization: a caller who
	// cannot open the page gets nothing.
	"accessibleFrame(",
	"openPage(",
	// Builds a handler that opens the page as the caller (`openPage`) before
	// it runs anything, so a handler written with it cannot leave that out.
	"pageTool(",
	"await authorize(",
] as const;

/** Handler name prefixes that mean the handler changes something. */
const WRITE_PREFIXES = [
	"handleCreate",
	"handleUpdate",
	// `fabric_upsert_project_context` creates or replaces a context row. Without
	// this prefix the scan read it as a read, which only needs a visibility
	// check — the exact gap this guard exists to close.
	"handleUpsert",
	"handleComplete",
	"handleShare",
	"handleExecute",
	// `fabric_generate_report` starts a run that spends the owner's AI credits.
	"handleGenerate",
	"handleSwitch",
	"handleRequest",
	"handleRevoke",
	"handleRestore",
	"handleDuplicate",
	"handleCancel",
	"handleLink",
	"handleUnlink",
	"handleSetAgentRunSchedule",
	"handleSetPage",
	"handleDeletePage",
	"handleUploadPage",
	"handleAddPage",
	"handleAskPage",
	// `handleMemoryWrite` writes files into a repository folder; its siblings
	// `handleMemoryTargets` and `handleMemoryWriteStatus` match the prefix too
	// and are held to the stricter list, which their live CONTEXT_READ check meets.
	"handleMemoryWrite",
	"handleDeleteInstructionSet",
] as const;

/**
 * Writes that legitimately resolve no project role, each with the reason.
 *
 * Keep the reasons. An exemption list without them becomes the place
 * inconvenient findings go to be forgotten, which is roughly how the three
 * handlers this guard exists for survived.
 */
const WRITE_EXEMPT = new Map<string, string>([
	[
		"handleCreateFrame",
		"delegates to the frame service, which gates on WORKSPACE_CREATE",
	],
	[
		"handleCreateSlideshow",
		"delegates to the frame service, which gates on WORKSPACE_CREATE",
	],
	[
		"handleUpdateFrame",
		"delegates to the frame service, which gates on WORKSPACE_UPDATE",
	],
	[
		"handleShareFrame",
		"delegates to the frame service, which gates on WORKSPACE_UPDATE, shares only a page the caller owns and follows the organization's public-link policy",
	],
	...[
		"handleSetPageData",
		"handleDeletePageData",
		"handleUploadPageFile",
		"handleDeletePageFile",
		"handleAddPageComment",
		"handleAskPage",
	].map((name): [string, string] => [
		name,
		"writing to a page needs no more than being able to open it, which openPage checks as the caller in the caller's organization; the store stamps what is written with the caller, and a public viewer cannot reach the gateway at all",
	]),
	[
		"handleRestoreFrameVersion",
		"delegates to the frame service, which gates on WORKSPACE_UPDATE and refuses anyone but the page's owner",
	],
	[
		"handleDuplicateFrame",
		"returns a handler that delegates to the frame service, which gates on WORKSPACE_CREATE and opens the source page as the caller",
	],
	[
		"handleCreateProjectReport",
		"delegates to createProjectReportForAgent, which checks REPORT_CREATE on the caller's organization role and canCreateProjectReport on the project; the project is asked of resolveGatewayReportProjectAccess, which keeps a project-bound session to its project",
	],
	[
		"handleGenerateReport",
		"delegates to generateReportForAgent, which checks REPORT_EXECUTE on the caller's organization role and refuses anyone but the report's owner; the report's project is asked of resolveGatewayReportProjectAccess, which keeps a project-bound session to its project",
	],
	[
		"handleUpdateReportPrompt",
		"delegates to updateReportPromptForAgent, which checks REPORT_READ on the caller's organization role and canEditReportInstance and the project write check the report page's save makes; the report's project is asked of resolveGatewayReportProjectAccess, which keeps a project-bound session to its project",
	],
	[
		"handleRequestAuthority",
		"grants the caller's own session time-bounded provider access; the subject is the caller",
	],
	[
		"handleRevokeAuthority",
		"withdraws the caller's own authority; the subject is the caller",
	],
]);

/** Reads that consult nothing, each with the reason. */
const READ_EXEMPT = new Map<string, string>([
	[
		"handleGetIdentity",
		"reports the session's own identity; there is no other subject",
	],
	[
		"handleListOrganizations",
		"lists the caller's own memberships, which is the authorization",
	],
	[
		"handleListProjectInstructions",
		"delegates to resolvePublishedInstructionSnapshot, which gates on resolveGatewayProjectReadAccess (project access plus the organization-key binding)",
	],
	[
		"handleGetProjectInstruction",
		"delegates to resolvePublishedInstructionSnapshot, which gates on resolveGatewayProjectReadAccess (project access plus the organization-key binding)",
	],
	[
		"handleGetProjectInstructionBundle",
		"delegates to resolvePublishedInstructionSnapshot, which gates on resolveGatewayProjectReadAccess (project access plus the organization-key binding)",
	],
	[
		"handleGetInstructionChecks",
		"delegates to resolvePublishedInstructionSnapshot, which gates on resolveGatewayProjectReadAccess (project access plus the organization-key binding)",
	],
]);

/**
 * Every handler's own text, and nothing after it.
 *
 * A body ends at the next top-level function declaration of ANY name, not
 * just the next handler: shared helpers sit between handlers in this file,
 * and a helper that mentions a gate would otherwise vouch for whichever
 * handler happens to precede it — green with that handler's own gate deleted.
 */
function handlerBodies(): Array<{ name: string; body: string }> {
	const out: Array<{ name: string; body: string }> = [];
	for (const file of SOURCES) {
		// A handler is a function declaration, or a `const` built with
		// `pageTool(`, which stays in the body so the gate it stands for is seen.
		const parts = readFileSync(file, "utf8").split(
			/\n(?:export\s+)?(?:(?:async\s+)?function\s+(\w+)(?=\s*[<(])|const\s+(\w+)\s*=\s*(?=pageTool\())/,
		);
		for (let i = 1; i < parts.length; i += 3) {
			const name = parts[i] ?? parts[i + 1];
			if (name?.startsWith("handle")) {
				out.push({ name, body: parts[i + 2] });
			}
		}
	}
	out.push(
		...FABRIC_PROJECT_PM_TOOL_DEFINITIONS.map(({ name }) => ({
			name: handlerOf(name),
			body: PM_HANDLER_BODY,
		})),
	);
	out.push(
		...CONTEXT_QUALITY_HANDLERS.map(({ name, body }) => ({ name, body })),
		...SAVED_CONTEXT_QUALITY_TOOLS.map((tool) => ({
			name: handlerOf(tool),
			body: SAVED_CONTEXT_QUALITY_HANDLER_BODY,
		})),
		...AGENT_RESULT_QUALITY_TOOLS.map((tool) => ({
			name: handlerOf(tool),
			body: AGENT_RESULT_QUALITY_HANDLER_BODY,
		})),
		...CONTEXT_SELECTION_TOOLS.map((tool) => ({
			name: handlerOf(tool),
			body: CONTEXT_SELECTION_HANDLER_BODY,
		})),
		...WORKSPACE_DOCUMENT_LINK_TOOLS.map((tool) => ({
			name: handlerOf(tool),
			body: WORKSPACE_DOCUMENT_LINK_HANDLER_BODY,
		})),
		...AGENT_RUN_TOOLS.map((tool) => ({
			name: handlerOf(tool),
			body: AGENT_RUN_HANDLER_BODY,
		})),
	);
	return out;
}

const isWrite = (name: string) =>
	WRITE_PREFIXES.some((prefix) => name.startsWith(prefix));

describe("platform tool authorization coverage", () => {
	it("wires both context-quality handlers through the canonical project guard before source/scoring access", () => {
		const platform = readFileSync(SOURCES[0], "utf8");
		expect(platform).toMatch(
			/const CONTEXT_QUALITY_TOOLS = createContextQualityTools\(\s*resolveGatewayProjectReadAccess,\s*resolveGatewayProjectWriteAccessWithHost,?\s*\);/,
		);
		expect(platform).toContain("...CONTEXT_QUALITY_TOOLS.definitions");
		expect(platform).toContain("...CONTEXT_QUALITY_TOOLS.handlers");
		for (const { tool, command, body } of CONTEXT_QUALITY_HANDLERS) {
			expect(PLATFORM_TOOL_DEFINITIONS.map(({ name }) => name)).toContain(
				tool,
			);
			expect(body.length, tool).toBeGreaterThan(100);
			expect(body, tool).toMatch(
				/const access = await authorize\(input\.data\.projectId, session\);\s*if \(!access\?\.organizationId\) \{\s*return errorResult\("Project not found or access denied"\);\s*\}/,
			);
			expect(body, tool).toContain(
				"organizationId: access.organizationId",
			);
			expect(body, tool).toContain("userId: session.userId");
			expect(body.indexOf(`await ${command}(`), tool).toBeGreaterThan(
				body.indexOf("await authorize("),
			);
		}
	});

	it("holds saved writes to the host-aware PROJECT_UPDATE gate before shared-command reauthorization", () => {
		expect(SAVED_CONTEXT_QUALITY_HANDLER_BODY.length).toBeGreaterThan(100);
		expect(SAVED_CONTEXT_QUALITY_HANDLER_BODY).toContain(
			"if (!resolveGatewayProjectWriteAccessWithHost)",
		);
		expect(SAVED_CONTEXT_QUALITY_HANDLER_BODY).toMatch(
			/await resolveGatewayProjectWriteAccessWithHost\(\s*input\.data\.projectId,\s*session,\s*"PROJECT_UPDATE",?\s*\)/,
		);
		expect(
			SAVED_CONTEXT_QUALITY_HANDLER_BODY.indexOf("await command("),
		).toBeGreaterThan(
			SAVED_CONTEXT_QUALITY_HANDLER_BODY.indexOf(
				"await resolveGatewayProjectWriteAccessWithHost(",
			),
		);
		expect(SAVED_CONTEXT_QUALITY_HANDLER_BODY).toContain(
			"organizationId = access.organizationId",
		);
		expect(SAVED_CONTEXT_QUALITY_HANDLER_BODY).toContain(
			"userId: session.userId",
		);
		for (const tool of SAVED_CONTEXT_QUALITY_TOOLS) {
			expect(CONTEXT_QUALITY_FAMILY_SOURCE).toContain(`"${tool}"`);
			expect(PLATFORM_TOOL_DEFINITIONS.map(({ name }) => name)).toContain(
				tool,
			);
		}
	});

	it("wires agent-result quality, context selection, workspace-document links, and agent-run controls through canonical guards", () => {
		const platform = readFileSync(SOURCES[0], "utf8");
		expect(platform).toMatch(
			/const AGENT_RESULT_QUALITY_TOOLS = createAgentResultQualityTools\(\s*resolveGatewayProjectReadAccess,?\s*\);/,
		);
		expect(platform).toMatch(
			/const CONTEXT_SELECTION_TOOLS = createContextSelectionTools\(\s*resolveGatewayProjectReadAccess,?\s*\);/,
		);
		expect(platform).toMatch(
			/const WORKSPACE_DOCUMENT_LINK_TOOLS = createWorkspaceDocumentLinkTools\(\s*resolveGatewayProjectReadAccess,?\s*\);/,
		);
		expect(platform).toContain(
			"const AGENT_RUN_TOOLS = createAgentRunTools();",
		);

		expect(AGENT_RESULT_QUALITY_HANDLER_BODY.length).toBeGreaterThan(100);
		expect(
			AGENT_RESULT_QUALITY_HANDLER_BODY.indexOf("agentResultCommands()"),
		).toBeGreaterThan(
			AGENT_RESULT_QUALITY_HANDLER_BODY.indexOf(
				"await authorize(projectId, session)",
			),
		);

		expect(CONTEXT_SELECTION_HANDLER_BODY.length).toBeGreaterThan(100);
		expect(
			CONTEXT_SELECTION_HANDLER_BODY.indexOf("assembleSelectedContext("),
		).toBeGreaterThan(
			CONTEXT_SELECTION_HANDLER_BODY.indexOf(
				"await authorize(projectId, session)",
			),
		);

		expect(WORKSPACE_DOCUMENT_LINK_HANDLER_BODY.length).toBeGreaterThan(
			100,
		);
		expect(
			WORKSPACE_DOCUMENT_LINK_HANDLER_BODY.indexOf(
				"workspaceDocumentLinkCommands()",
			),
		).toBeGreaterThan(
			WORKSPACE_DOCUMENT_LINK_HANDLER_BODY.indexOf(
				"await authorize(projectId, session)",
			),
		);

		expect(AGENT_RUN_HANDLER_BODY.length).toBeGreaterThan(100);
		expect(AGENT_RUN_HANDLER_BODY).toContain(
			'session.credential === "service"',
		);
		expect(
			AGENT_RUN_HANDLER_BODY.indexOf("await command("),
		).toBeGreaterThan(
			AGENT_RUN_HANDLER_BODY.indexOf("!session.organizationId"),
		);

		for (const tool of [
			...AGENT_RESULT_QUALITY_TOOLS,
			...CONTEXT_SELECTION_TOOLS,
			...WORKSPACE_DOCUMENT_LINK_TOOLS,
			...AGENT_RUN_TOOLS,
		]) {
			expect(PLATFORM_TOOL_DEFINITIONS.map(({ name }) => name)).toContain(
				tool,
			);
		}
	});

	it("wires every PM definition through the canonical project guard before any PM lookup", () => {
		const platform = readFileSync(SOURCES[0], "utf8");
		expect(platform).toMatch(
			/const PROJECT_PM_TOOLS = createProjectPmTools\(resolveGatewayProjectReadAccess\);/,
		);
		expect(platform).toContain("...PROJECT_PM_TOOLS.definitions");
		expect(platform).toContain("...PROJECT_PM_TOOLS.handlers");
		expect(PM_FAMILY_SOURCE).toContain(
			"for (const tool of FABRIC_PROJECT_PM_TOOL_DEFINITIONS)",
		);
		expect(PM_FAMILY_SOURCE).toContain(
			"return toolFamily(FABRIC_PROJECT_PM_TOOL_DEFINITIONS, handlers)",
		);
		expect(PM_HANDLER_BODY).toMatch(
			/const access = await authorize\(\s*parsed\.data\.input\.projectId,\s*session,?\s*\);\s*if \(!access\?\.organizationId\) \{\s*return errorResult\("Project not found or access denied"\);\s*\}\s*const result = await readProjectPmTool\(/,
		);
		expect(
			PM_HANDLER_BODY.indexOf("await readProjectPmTool("),
		).toBeGreaterThan(PM_HANDLER_BODY.indexOf("await authorize("));
	});

	it("wires the report tools through the canonical project guard and the API's report commands", () => {
		const platform = readFileSync(SOURCES[0], "utf8");
		expect(platform).toContain(
			"const REPORT_TOOLS = createReportTools(resolveGatewayReportProjectAccess);",
		);
		// The report gate is the canonical guard plus the organization admin's
		// inheritance, under the same session and credential bindings.
		const reportGate =
			platform.match(
				/async function resolveGatewayReportProjectAccess\(([\s\S]*?)\n\}\n/,
			)?.[1] ?? "";
		expect(reportGate).toContain("await resolveGatewayProjectReadAccess(");
		expect(reportGate).toContain(
			"sessionMayReachProject(session, projectId)",
		);
		expect(reportGate).toContain(
			"credentialMayReachHost(session, administered.organizationId)",
		);
		expect(platform).toContain("...REPORT_TOOLS.definitions");
		expect(platform).toContain("...REPORT_TOOLS.handlers");
		const bodies = new Map(
			handlerBodies().map(({ name, body }) => [name, body]),
		);
		const list = bodies.get("handleListProjectReports") ?? "";
		expect(list.indexOf("listProjectReportsForAgent(")).toBeGreaterThan(
			list.indexOf("await authorize(parsed.data.projectId, session)"),
		);
		expect(list.indexOf("await authorize(")).toBeGreaterThan(-1);
		// A report found by id has its project asked of `authorize`, or of
		// the session's own binding when it has none.
		const reportTools = readFileSync(
			resolve(process.cwd(), GATEWAY_DIRECTORY, "tools/report-tools.ts"),
			"utf8",
		);
		const reach =
			reportTools.match(
				/function reportProjectReach\(([\s\S]*?)\n\}\n/,
			)?.[1] ?? "";
		expect(reach).toContain("await authorize(projectId, session)");
		expect(reach).toContain("sessionMayReachProject(session, null)");
		const templates = bodies.get("handleListReportTemplates") ?? "";
		expect(
			templates.indexOf("listReportTemplatesForAgent("),
		).toBeGreaterThan(
			templates.indexOf(
				"await authorize(parsed.data.projectId, session)",
			),
		);
		expect(templates.indexOf("await authorize(")).toBeGreaterThan(-1);
		for (const [handler, command] of [
			["handleCreateProjectReport", "createProjectReportForAgent("],
			["handleGenerateReport", "generateReportForAgent("],
			["handleGetReportContent", "getReportContentForAgent("],
			["handleUpdateReportPrompt", "updateReportPromptForAgent("],
		]) {
			const body = bodies.get(handler) ?? "";
			expect(body, handler).toContain(
				"reportProjectReach(session, authorize, organizationId)",
			);
			expect(body.indexOf(command), handler).toBeGreaterThan(
				body.indexOf("!organizationId"),
			);
			expect(body.indexOf("!organizationId"), handler).toBeGreaterThan(
				-1,
			);
		}
		// The exemptions for handleCreateProjectReport, handleGenerateReport and
		// handleUpdateReportPrompt rest on these API checks.
		const commands = readFileSync(
			resolve(
				process.cwd(),
				"../../packages/api/modules/reports/lib/report-agent-commands.ts",
			),
			"utf8",
		);
		expect(commands).toMatch(
			/await assertAgentMayReachReports\(\s*actor,\s*Permissions\.REPORT_EXECUTE,?\s*\)/,
		);
		expect(commands).toContain("await loadGeneratableReport(");
		expect(commands).toContain(
			"await assertAgentMayReachReports(actor, Permissions.REPORT_READ);",
		);
		expect(commands).toContain(
			"!(await canEditReportInstance(instance, caller))",
		);
		expect(commands).toMatch(
			/await assertAgentMayReachReports\(\s*actor,\s*Permissions\.REPORT_CREATE,?\s*\)/,
		);
		expect(commands).toContain(
			"!(await canCreateProjectReport(input.projectId, caller))",
		);
		for (const tool of [
			"fabric_list_project_reports",
			"fabric_list_report_templates",
			"fabric_create_project_report",
			"fabric_generate_report",
			"fabric_get_report_content",
			"fabric_update_report_prompt",
		]) {
			expect(PLATFORM_TOOL_DEFINITIONS.map(({ name }) => name)).toContain(
				tool,
			);
		}
	});

	it("every write resolves the caller's permission, not just their sight of the resource", () => {
		const ungated = handlerBodies()
			.filter(({ name }) => isWrite(name) && !WRITE_EXEMPT.has(name))
			.filter(
				({ body }) =>
					!PERMISSION_GATES.some((gate) => body.includes(gate)),
			)
			.map(({ name }) => name);

		expect(ungated).toEqual([]);
	});

	it("every read consults something about the caller", () => {
		const ungated = handlerBodies()
			.filter(({ name }) => !isWrite(name) && !READ_EXEMPT.has(name))
			.filter(
				({ body }) =>
					![...PERMISSION_GATES, ...VISIBILITY_GATES].some((gate) =>
						body.includes(gate),
					),
			)
			.map(({ name }) => name);

		expect(ungated).toEqual([]);
	});

	it("finds handlers at all, so a rename cannot silently empty the scan", () => {
		// A scan over zero handlers is green and worthless.
		expect(handlerBodies().length).toBeGreaterThan(30);
		expect(
			handlerBodies().filter(({ name }) => isWrite(name)).length,
		).toBeGreaterThan(10);
	});

	it("exempts no handler that has since gone away", () => {
		const present = new Set(handlerBodies().map((h) => h.name));
		const stale = [...WRITE_EXEMPT.keys(), ...READ_EXEMPT.keys()]
			.filter((name) => !present.has(name))
			.sort();

		expect(stale).toEqual([]);
	});
});

/**
 * A session bound to one project (`../project-binding`) has the platform tools
 * that answer for one project and none that reach past it. Which are which is
 * decided tool by tool, in two lists; a tool in neither is refused, and this is
 * the test that fails until a new one is put in one of them — so a tool added
 * later is organization-wide until somebody has decided it is project-safe, and
 * never project-safe by default.
 */
describe("platform tools classified for a project-bound session", () => {
	const allowed: readonly string[] = PROJECT_BOUND_TOOL_NAMES;
	const hidden: readonly string[] = PROJECT_BOUND_HIDDEN_TOOL_NAMES;
	const defined = PLATFORM_TOOL_DEFINITIONS.map((tool) => tool.name);

	it("classifies every platform tool as allowed or hidden", () => {
		const unclassified = defined
			.filter((name) => !allowed.includes(name) && !hidden.includes(name))
			.sort();

		expect(unclassified).toEqual([]);
	});

	it("classifies no tool both ways", () => {
		const both = allowed.filter((name) => hidden.includes(name)).sort();

		expect(both).toEqual([]);
	});

	it("names no tool that does not exist", () => {
		const unknown = [...allowed, ...hidden]
			.filter((name) => !defined.includes(name))
			.sort();

		expect(unknown).toEqual([]);
	});

	it("lists no tool twice", () => {
		const all = [...allowed, ...hidden];

		expect(all.length).toBe(new Set(all).size);
	});

	it("finds tools at all, so an empty definition list cannot pass the checks above", () => {
		expect(defined.length).toBeGreaterThan(40);
		expect(allowed.length).toBeGreaterThan(20);
	});

	/**
	 * What an allowed tool is allowed BECAUSE of: it asks the project-access
	 * helpers about a project (which refuse any but the bound one) or, for the
	 * two that describe the connection, answers for the bound project itself.
	 * A handler with none of them has nothing holding it to one project.
	 */
	it("keeps every allowed tool's handler behind a project-access helper, or on the bound project", () => {
		const helpers = [
			"hasGatewayProjectAccess",
			"resolveGatewayProjectReadAccess",
			"resolveGatewayProjectWriteAccess",
			"resolveInstructionProjectAccess",
			"resolvePublishedInstructionSnapshot",
			"resolveProjectForStoryWrite",
			"sessionMayReachProject",
			"boundProjectId",
			"await authorize(",
			// The report tools' shared reach check; its body is asserted above.
			"reportProjectReach(",
		];
		const bodies = new Map(
			handlerBodies().map(({ name, body }) => [name, body]),
		);
		// Handlers whose name is not the tool's in PascalCase.
		const renamed = new Map([
			["fabric_instruction_checks", "handleGetInstructionChecks"],
		]);

		const unguarded = allowed
			.filter((tool) => {
				const body = bodies.get(renamed.get(tool) ?? handlerOf(tool));
				return (
					body === undefined ||
					!helpers.some((helper) => body.includes(helper))
				);
			})
			.sort();

		expect(unguarded).toEqual([]);
	});
});
