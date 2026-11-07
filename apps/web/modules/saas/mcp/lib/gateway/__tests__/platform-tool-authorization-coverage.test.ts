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
const BRAND_FAMILY_SOURCE = readFileSync(
	resolve(process.cwd(), GATEWAY_DIRECTORY, "tools/brand-tools.ts"),
	"utf8",
);
const BRAND_COMMAND_SOURCE = readFileSync(
	resolve(
		process.cwd(),
		"../../packages/api/modules/branding/lib/brand-commands.ts",
	),
	"utf8",
);
const STYLE_COMMAND_SOURCE = readFileSync(
	resolve(
		process.cwd(),
		"../../packages/api/modules/branding/lib/proposal-style-commands.ts",
	),
	"utf8",
);
const STYLE_WRITE_SOURCE = readFileSync(
	resolve(
		process.cwd(),
		"../../packages/api/modules/projects/procedures/proposal-artifact/update-style.ts",
	),
	"utf8",
);

const BRAND_HANDLER_BODY =
	BRAND_FAMILY_SOURCE.match(
		/handlers\.set\(definition\.name, async \(args, session\) => \{([\s\S]*?)\n\t\t\}\);/,
	)?.[1] ?? "";
const BRAND_PROJECT_TOOLS = [
	"fabric_get_artifact_brand",
	"fabric_update_client_brand",
	"fabric_get_proposal_style",
	"fabric_update_proposal_style",
];
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

// These injected factories use closure handlers rather than PascalCase function
// declarations. Credit only their exact handler body, after proving the factory
// is wired to the canonical project guard and retains its own binding check.
const PROJECT_CLOSURE_FAMILIES = [
	{
		file: "context-selection-tools.ts",
		factory: "createContextSelectionTools",
		registry: "CONTEXT_SELECTION_TOOLS",
		tools: ["fabric_assemble_project_context"],
		pattern:
			/const handler: PlatformToolHandler = async \(args, session\) => \{([\s\S]*?)\n\t\};/,
	},
	{
		file: "agent-result-quality-tools.ts",
		factory: "createAgentResultQualityTools",
		registry: "AGENT_RESULT_QUALITY_TOOLS",
		tools: [
			"fabric_inspect_agent_run_result",
			"fabric_check_agent_run_result",
		],
		pattern:
			/handlers\.set\(name, async \(raw, session\) => \{([\s\S]*?)\n\t\t\}\);/,
	},
	{
		file: "workspace-document-link-tools.ts",
		factory: "createWorkspaceDocumentLinkTools",
		registry: "WORKSPACE_DOCUMENT_LINK_TOOLS",
		tools: [
			"fabric_list_project_workspace_documents",
			"fabric_read_project_workspace_document",
			"fabric_link_workspace_document",
			"fabric_unlink_workspace_document",
		],
		pattern:
			/handlers\.set\(name, async \(args, session\) => \{([\s\S]*?)\n\t\t\}\);/,
	},
].map((family) => {
	const source = readFileSync(
		resolve(process.cwd(), GATEWAY_DIRECTORY, "tools", family.file),
		"utf8",
	);
	return { ...family, source, body: source.match(family.pattern)?.[1] ?? "" };
});

// These families enforce binding locally and reuse the exact authorized API command.
const DELIVERY_FAMILIES = [
	{
		file: "delivery-source-tools.ts",
		registry: "DELIVERY_SOURCE_TOOLS",
		factory: "createDeliverySourceTools",
		tools: [
			"fabric_delivery_source_list",
			"fabric_delivery_source_inspect",
			"fabric_delivery_source_configure",
			"fabric_delivery_source_pause",
			"fabric_delivery_source_resume",
			"fabric_delivery_source_disconnect",
			"fabric_delivery_source_capture",
			"fabric_delivery_source_status",
			"fabric_delivery_source_cancel",
			"fabric_delivery_source_observations",
			"fabric_delivery_source_evidence",
		],
		pattern:
			/handlers\.set\(definition\.name, async \(args, session\) => \{([\s\S]*?)\n\t\t\}\);/,
	},
	{
		file: "delivery-signal-tools.ts",
		registry: "DELIVERY_SIGNAL_TOOLS",
		factory: "createDeliverySignalTools",
		tools: [
			"fabric_list_delivery_signals",
			"fabric_get_delivery_signal",
			"fabric_get_delivery_signal_sources",
		],
		pattern:
			/handlers\.set\(definition\.name, async \(args, session\) => \{([\s\S]*?)\n\t\t\}\);/,
	},
	{
		file: "project-delivery-tools.ts",
		registry: "PROJECT_DELIVERY_TOOLS",
		factory: "createProjectDeliveryTools",
		tools: ["fabric_get_project_delivery"],
		pattern:
			/const handler: PlatformToolHandler = async \(args, session\) => \{([\s\S]*?)\n\t\};/,
	},
	{
		file: "implementation-session-tools.ts",
		registry: "IMPLEMENTATION_TOOLS",
		factory: "createImplementationSessionTools",
		tools: [
			"fabric_list_implementation_sessions",
			"fabric_get_implementation_session",
			"fabric_start_implementation_session",
			"fabric_cancel_implementation_session",
			"fabric_follow_up_implementation_session",
			"fabric_get_implementation_messages",
		],
		pattern:
			/handlers\.set\(definition\.name, async \(args, session\) => \{([\s\S]*?)\n\t\t\}\);/,
	},
].map((family) => {
	const source = readFileSync(
		resolve(process.cwd(), GATEWAY_DIRECTORY, "tools", family.file),
		"utf8",
	);
	return { ...family, source, body: source.match(family.pattern)?.[1] ?? "" };
});

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
	resolve(process.cwd(), GATEWAY_DIRECTORY, "tools/frame-tools.ts"),
	resolve(process.cwd(), GATEWAY_DIRECTORY, "tools/frame-version-tools.ts"),
	resolve(process.cwd(), GATEWAY_DIRECTORY, "tools/page-tools.ts"),
	resolve(process.cwd(), GATEWAY_DIRECTORY, "tools/page-data-tools.ts"),
	resolve(process.cwd(), GATEWAY_DIRECTORY, "tools/page-file-tools.ts"),
	resolve(process.cwd(), GATEWAY_DIRECTORY, "tools/page-comment-tools.ts"),
	resolve(process.cwd(), GATEWAY_DIRECTORY, "tools/page-ask-tool.ts"),
];

/** Resolves what the caller may *do*. */
const PERMISSION_GATES = [
	// The finite triage facade repeats current project role checks for writes;
	// its runtime/owner/scope tests exercise all six operations separately.
	"privateTriageCommands[op](",
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
	"handleTriageStart",
	"handleTriageCancel",
	"handleTriageReview",
	"handleCreate",
	"handleUpdate",
	// `fabric_upsert_project_context` creates or replaces a context row. Without
	// this prefix the scan read it as a read, which only needs a visibility
	// check — the exact gap this guard exists to close.
	"handleUpsert",
	"handleComplete",
	"handleShare",
	"handleExecute",
	"handleSwitch",
	"handleRequest",
	"handleRevoke",
	"handleRestore",
	"handleDuplicate",
	"handleSetPage",
	"handleDeletePage",
	"handleUploadPage",
	"handleAddPage",
	"handleAskPage",
	// `handleMemoryWrite` writes files into a repository folder; its siblings
	// `handleMemoryTargets` and `handleMemoryWriteStatus` match the prefix too
	// and are held to the stricter list, which their live CONTEXT_READ check meets.
	"handleMemoryWrite",
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
	);
	out.push(
		...[...PROJECT_CLOSURE_FAMILIES, ...DELIVERY_FAMILIES].flatMap(
			({ tools, body }) =>
				tools.map((tool) => ({ name: handlerOf(tool), body })),
		),
	);
	out.push(
		...BRAND_PROJECT_TOOLS.map((tool) => ({
			name: handlerOf(tool),
			body: BRAND_HANDLER_BODY,
		})),
	);
	const triageSource = readFileSync(
		resolve(
			process.cwd(),
			"modules/saas/mcp/lib/gateway/tools/harness-triage-tools.ts",
		),
		"utf8",
	);
	for (const op of [
		"list",
		"start",
		"status",
		"result",
		"cancel",
		"review",
	]) {
		out.push({
			name: handlerOf(`fabric_triage_${op}`),
			body: triageSource,
		});
	}

	return out;
}

const isWrite = (name: string) =>
	WRITE_PREFIXES.some((prefix) => name.startsWith(prefix));

describe("platform tool authorization coverage", () => {
	it("keeps finite triage behind canonical current-actor commands and a private runtime gate", () => {
		const source = readFileSync(
			resolve(
				process.cwd(),
				"modules/saas/mcp/lib/gateway/tools/harness-triage-tools.ts",
			),
			"utf8",
		);
		expect(source).toContain("triageScopeRefusal(");
		expect(source).toContain("sessionMayReachProject(");
		expect(source).toContain("privateTriageCommands[op](actor, args)");
		expect(source).toContain("s.keyIdentity");
		expect(source).toContain('s.credential === "service"');
	});

	it.each(DELIVERY_FAMILIES)(
		"proves $file binding and canonical actor authority before dispatch",
		(family) => {
			const platform = readFileSync(SOURCES[0], "utf8");
			expect(platform).toContain(
				`const ${family.registry} = ${family.factory}()`,
			);
			expect(platform).toContain(`${family.registry}.`);
			expect(family.body.length).toBeGreaterThan(100);
			expect(family.body).toContain("sessionMayReachProject(");
			expect(family.body).toContain("session.organizationId");
			expect(family.body).toContain("session.credential");
			if (family.file === "delivery-signal-tools.ts") {
				expect(family.body).toContain("deliverySignalScopeRefusal(");
				expect(family.source).toContain("requireDeliverySignalScopes(");
				expect(family.source).toContain("session.scopes");
			} else if (family.file === "delivery-source-tools.ts") {
				expect(family.body).toContain("deliverySourceScopeRefusal(");
				expect(family.source).toContain(
					"deliverySourceRequiredScopes(",
				);
			} else {
				expect(family.body).toContain("session.scopes.includes(");
			}
			expect(family.body).toContain("userId: session.userId");
			expect(family.body.indexOf("return jsonResult(")).toBeGreaterThan(
				family.body.indexOf("sessionMayReachProject("),
			);
			for (const tool of family.tools) {
				expect(PLATFORM_TOOL_DEFINITIONS.map((x) => x.name)).toContain(
					tool,
				);
			}
			if (family.file === "project-delivery-tools.ts") {
				expect(family.body).toContain(
					"await getProjectDeliverySnapshot(",
				);
				const command = readFileSync(
					resolve(
						process.cwd(),
						"../../packages/api/modules/projects/lib/delivery-snapshot.ts",
					),
					"utf8",
				);
				expect(command).toContain(
					"resolveEffectiveProjectPermissions(",
				);
				expect(command).toContain("hasProjectAccess(");
				expect(command).toContain(
					"hasPermission(access.permissions, Permissions.PROJECT_READ)",
				);
			} else if (family.file === "delivery-signal-tools.ts") {
				for (const command of [
					"listDeliverySignals",
					"getDeliverySignal",
					"getDeliverySignalSourceConfiguration",
				]) {
					expect(family.body).toContain(command);
				}
				const command = readFileSync(
					resolve(
						process.cwd(),
						"../../packages/api/modules/projects/lib/delivery-signals.ts",
					),
					"utf8",
				);
				const sources = readFileSync(
					resolve(
						process.cwd(),
						"../../packages/api/modules/projects/lib/delivery-signal-sources.ts",
					),
					"utf8",
				);
				expect(command).toContain(
					"requireDeliverySignalProjectAccess(",
				);
				expect(command).toContain("assertProjectVisible(");
				expect(command).toContain(
					"resolveEffectiveProjectPermissions(",
				);
				expect(command).toContain("Permissions.PROJECT_READ");
				expect(command).toContain("Permissions.STORY_READ");
				expect(sources).toContain(
					"requireDeliverySignalProjectAccess(",
				);
				expect(sources).toContain(
					"requireDeliverySignalIntegrationRead(",
				);
			} else if (family.file === "delivery-source-tools.ts") {
				for (const command of [
					"listDeliverySourceWatches",
					"inspectDeliverySource",
					"configureDeliverySource",
					"updateDeliverySourceState",
					"startDeliverySourceCapture",
					"getDeliverySourceCaptureStatus",
					"cancelDeliverySourceCapture",
					"listDeliverySourceObservations",
					"getDeliverySourceEvidence",
				]) {
					expect(family.body).toContain(command);
				}
			} else {
				for (const command of [
					"listImplementationSessions",
					"getImplementationSession",
					"startImplementationSession",
					"cancelImplementationSession",
					"followUpImplementationSession",
					"getImplementationMessages",
				]) {
					expect(family.body).toContain(command);
				}
				const commands = readFileSync(
					resolve(
						process.cwd(),
						"../../packages/api/modules/coding-runs/lib/implementation-commands.ts",
					),
					"utf8",
				);
				const access = readFileSync(
					resolve(
						process.cwd(),
						"../../packages/api/modules/coding-runs/lib/commands-access.ts",
					),
					"utf8",
				);
				expect(commands).toContain("requireCodingRunProject(");
				expect(access).toContain("resolveEffectiveProjectPermissions(");
				expect(access).toContain("hasProjectAccess(");
				expect(access).toContain(
					"hasPermission(access.permissions, permission)",
				);
				expect(access).toContain("canEditProject(");
			}
		},
	);
	it("credits only the wired project-bound brand family and its canonical object guards", () => {
		const platform = readFileSync(
			resolve(process.cwd(), GATEWAY_DIRECTORY, "platform-tools.ts"),
			"utf8",
		);
		expect(platform).toContain("const BRAND_TOOLS = createBrandTools()");
		expect(platform).toContain("...BRAND_TOOLS.handlers");
		expect(BRAND_HANDLER_BODY.length).toBeGreaterThan(100);
		expect(BRAND_HANDLER_BODY).toContain(
			"sessionMayReachProject(session, projectId)",
		);
		expect(BRAND_HANDLER_BODY).toContain("getArtifactBrandCommand(");
		expect(BRAND_HANDLER_BODY).toContain("saveClientBrandCommand(");
		expect(BRAND_HANDLER_BODY).toContain("getProposalStyleCommand(");
		expect(BRAND_HANDLER_BODY).toContain("saveProposalStyleCommand(");
		expect(STYLE_COMMAND_SOURCE).toMatch(
			/await assertProjectPermission\([\s\S]*?Permissions\.DOCUMENT_READ/,
		);
		expect(STYLE_COMMAND_SOURCE).toContain(
			"permission.organizationId !== actor.organizationId",
		);
		expect(STYLE_COMMAND_SOURCE).toContain(
			"return updateProposalStyleCommand(",
		);
		const styleWrite = STYLE_WRITE_SOURCE.slice(
			STYLE_WRITE_SOURCE.indexOf(
				"export async function updateProposalStyleCommand",
			),
		);
		expect(styleWrite).toMatch(
			/await assertProjectPermission\([\s\S]*?Permissions\.DOCUMENT_UPDATE/,
		);
		expect(styleWrite).toContain(
			"permission.organizationId !== actor.organizationId",
		);
		expect(styleWrite).toContain("await loadProposalArtifactDocument(");

		expect(BRAND_COMMAND_SOURCE).toMatch(
			/await assertProjectPermission\([\s\S]*?Permissions\.DOCUMENT_READ/,
		);
		const save = BRAND_COMMAND_SOURCE.slice(
			BRAND_COMMAND_SOURCE.indexOf(
				"export async function saveClientBrandCommand",
			),
		);
		expect(save).toMatch(
			/await assertProjectPermission\([\s\S]*?Permissions\.DOCUMENT_UPDATE/,
		);
		expect(save).toContain(
			"authorized.organizationId !== actor.organizationId",
		);
	});

	it.each(PROJECT_CLOSURE_FAMILIES)(
		"proves the $file closure checks binding and canonical project authority before calling commands",
		(family) => {
			const platform = readFileSync(SOURCES[0], "utf8");
			expect(platform).toMatch(
				new RegExp(
					`const ${family.registry} = ${family.factory}\\(\\s*resolveGatewayProjectReadAccess,?\\s*\\);`,
				),
			);
			expect(family.body.length).toBeGreaterThan(100);
			expect(family.body).toContain(
				"sessionMayReachProject(session, projectId)",
			);
			expect(family.body).toContain(
				"const access = await authorize(projectId, session)",
			);
			expect(family.body).toContain("if (!access?.organizationId)");
			expect(family.body).toContain(
				"organizationId: access.organizationId",
			);
			expect(family.body).toContain("userId: session.userId");
			expect(family.body.indexOf("await authorize(")).toBeGreaterThan(
				family.body.indexOf("sessionMayReachProject("),
			);
			const dispatch = family.body.indexOf("return jsonResult(");
			expect(dispatch).toBeGreaterThan(
				family.body.indexOf("if (!access?.organizationId)"),
			);
			for (const tool of family.tools) {
				expect(PLATFORM_TOOL_DEFINITIONS.map((x) => x.name)).toContain(
					tool,
				);
				expect(family.source).toContain(`"${tool}"`);
			}
			expect(platform).toContain(`${family.registry}.`);
		},
	);

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
