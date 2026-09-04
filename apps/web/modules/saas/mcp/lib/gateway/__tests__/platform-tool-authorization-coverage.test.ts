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

// Resolved from the vitest root (`apps/web`) rather than from `import.meta.url`,
// which this runner does not give as a file URL.
const SOURCE = resolve(
	process.cwd(),
	"modules/saas/mcp/lib/gateway/platform-tools.ts",
);

/** Resolves what the caller may *do*. */
const PERMISSION_GATES = [
	"canEditProject",
	"canUpdateProjectStory",
	"canCreateProjectStory",
	"canCreateProjectInOrganization",
	"resolveProjectForStoryWrite",
	"isOrganizationMember",
	"session.credential",
] as const;

/** Resolves what the caller may *see*. Enough for a read, never for a write. */
const VISIBILITY_GATES = [
	"hasProjectAccess",
	"tenantFilter(",
	"session.organizationId",
] as const;

/** Handler name prefixes that mean the handler changes something. */
const WRITE_PREFIXES = [
	"handleCreate",
	"handleUpdate",
	"handleComplete",
	"handleShare",
	"handleExecute",
	"handleSwitch",
	"handleRequest",
	"handleRevoke",
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
		"delegates to the frame service, which gates on WORKSPACE_UPDATE",
	],
	[
		"handleExecuteWorkflow",
		"workflows are organization resources, scoped by tenant filter — the same reach the app gives any member",
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
]);

function handlerBodies(): Array<{ name: string; body: string }> {
	const source = readFileSync(SOURCE, "utf8");
	const parts = source.split(/\nasync function (handle\w+)\(/);
	const out: Array<{ name: string; body: string }> = [];
	for (let i = 1; i < parts.length; i += 2) {
		out.push({ name: parts[i], body: parts[i + 1] });
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
