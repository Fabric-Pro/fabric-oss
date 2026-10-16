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
import { describe, expect, it } from "vitest";
import { PLATFORM_TOOL_DEFINITIONS } from "../platform-tools";
import {
	PROJECT_BOUND_HIDDEN_TOOL_NAMES,
	PROJECT_BOUND_TOOL_NAMES,
} from "../project-binding";

// Resolved from the vitest root (`apps/web`) rather than from `import.meta.url`,
// which this runner does not give as a file URL.
const GATEWAY_DIRECTORY = "modules/saas/mcp/lib/gateway";

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
	return out;
}

const isWrite = (name: string) =>
	WRITE_PREFIXES.some((prefix) => name.startsWith(prefix));

describe("platform tool authorization coverage", () => {
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
		];
		const handlerOf = (tool: string) =>
			`handle${tool
				.replace(/^fabric_/, "")
				.split("_")
				.map((word) => word[0].toUpperCase() + word.slice(1))
				.join("")}`;
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
