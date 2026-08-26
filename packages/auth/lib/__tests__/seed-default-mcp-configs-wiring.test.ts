/**
 * Wiring tests for the Better Auth hooks that seed managed-default
 * `MCPConfig` rows.
 *
 * `packages/auth/auth.ts` constructs the Better Auth instance at module-load
 * time and pulls in dozens of side-effecting dependencies (Prisma, Temporal
 * client, email client, etc.). Booting it inside a Vitest worker just to
 * assert two callbacks invoke `seedDefaultMcpConfigsForTenant` is fragile
 * and slow. Instead, this suite verifies the wiring statically: we read the
 * source of `auth.ts` and assert (a) the helper is imported from
 * `@repo/agent-core/backend`, (b) every required hook site contains a call
 * that passes the right tenant tuple. This catches the most common
 * regression mode — a refactor that silently deletes one of the call sites
 * — without booting the full auth instance.
 *
 * The behavioral contract that "one call to `seedDefaultMcpConfigsForTenant`
 * produces exactly one row per `(userId, organizationId, mcpServerId)`
 * tuple, and a second call is a no-op" is locked by
 * `packages/agent-core/__tests__/mcp-tools-defaults.test.ts`. This file
 * locks the wiring; the helper test locks the helper.
 *
 * A live-DB integration test that performs `auth.api.signUp.email(...)`
 * and asserts a row was persisted is deferred to staging verification.
 * It is impractical to run against a mocked Prisma — the value comes
 * from booting the full Better Auth stack.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

let AUTH_SOURCE = "";

beforeAll(() => {
	// `auth.ts` lives at packages/auth/auth.ts — one level up from
	// packages/auth/lib/__tests__/. Read it once and reuse across every
	// assertion below.
	const here = dirname(fileURLToPath(import.meta.url));
	const authPath = join(here, "..", "..", "auth.ts");
	AUTH_SOURCE = readFileSync(authPath, "utf8");
});

describe("auth.ts hook wiring — seedDefaultMcpConfigsForTenant", () => {
	it("imports seedDefaultMcpConfigsForTenant from @repo/agent-core/backend", () => {
		expect(AUTH_SOURCE).toMatch(
			/import\s+\{[^}]*seedDefaultMcpConfigsForTenant[^}]*\}\s+from\s+["']@repo\/agent-core\/backend["']/,
		);
	});

	// -----------------------------------------------------------------------
	// user.create.after hook seeds the personal sentinel row.
	// The personal path MUST pass `organizationId: null` (XOR — never
	// `undefined`, never an org id).
	// -----------------------------------------------------------------------

	it("calls seedDefaultMcpConfigsForTenant with organizationId: null inside user.create.after", () => {
		// Look for the user-create call's literal `organizationId: null`
		// inside an `await seedDefaultMcpConfigsForTenant({ ... })` invocation.
		// Multiline match because the call spans several lines per code style.
		expect(AUTH_SOURCE).toMatch(
			/await\s+seedDefaultMcpConfigsForTenant\(\s*\{\s*userId:\s*user\.id\s*,\s*organizationId:\s*null/,
		);
	});

	// -----------------------------------------------------------------------
	// Organization-plugin hooks seed org sentinel rows.
	// Each hook must pass the member's tenant tuple (`member.userId`,
	// `member.organizationId`).
	// -----------------------------------------------------------------------

	it("calls seedDefaultMcpConfigsForTenant inside organizationHooks.afterCreateOrganization", () => {
		// First check the hook name appears.
		expect(AUTH_SOURCE).toContain("afterCreateOrganization");
		// Then check that within the hook body, the helper is called with
		// the member tuple. We accept any whitespace and any tuple-shape
		// (with or without trailing commas) so a minor formatting change
		// doesn't break the test, but reject the case where the seed is
		// silently removed.
		const block = sliceHookBlock(
			AUTH_SOURCE,
			"afterCreateOrganization",
			"afterAcceptInvitation",
		);
		expect(block).toMatch(/await\s+seedDefaultMcpConfigsForTenant\(/);
		expect(block).toMatch(/member\.userId/);
		expect(block).toMatch(/member\.organizationId/);
	});

	it("calls seedDefaultMcpConfigsForTenant inside organizationHooks.afterAcceptInvitation", () => {
		expect(AUTH_SOURCE).toContain("afterAcceptInvitation");
		const block = sliceHookBlock(
			AUTH_SOURCE,
			"afterAcceptInvitation",
			"afterAddMember",
		);
		expect(block).toMatch(/await\s+seedDefaultMcpConfigsForTenant\(/);
		expect(block).toMatch(/member\.userId/);
		expect(block).toMatch(/member\.organizationId/);
	});

	it("calls seedDefaultMcpConfigsForTenant inside organizationHooks.afterAddMember", () => {
		expect(AUTH_SOURCE).toContain("afterAddMember");
		// afterAddMember is the last hook in the block. Read from the
		// hook name to the closing `}` of organizationHooks.
		const block = sliceHookBlock(AUTH_SOURCE, "afterAddMember", "openAPI");
		expect(block).toMatch(/await\s+seedDefaultMcpConfigsForTenant\(/);
		expect(block).toMatch(/member\.userId/);
		expect(block).toMatch(/member\.organizationId/);
	});

	// -----------------------------------------------------------------------
	// Error handling — every hook wraps the call in try/catch so a seed
	// failure NEVER blocks signup/org-create/invite-accept (best-effort).
	// Locks the contract: if a future change removes the try/catch, this
	// test fires.
	// -----------------------------------------------------------------------

	it("every hook wraps the helper in try/catch so a failure never blocks the parent flow", () => {
		// Count seed call sites and try blocks within an N-char window
		// around each call. We use a regex that walks backward from each
		// call to find an enclosing `try {`.
		const callSites = [
			...AUTH_SOURCE.matchAll(
				/await\s+seedDefaultMcpConfigsForTenant\(/g,
			),
		];
		expect(callSites.length).toBeGreaterThanOrEqual(4);

		for (const match of callSites) {
			const start = Math.max(0, match.index! - 200);
			const window = AUTH_SOURCE.slice(start, match.index! + 1);
			expect(
				window,
				`call site at offset ${match.index} should be inside a try {} block`,
			).toMatch(/try\s*\{[\s\S]*?$/);
		}
	});
});

/**
 * Slice the source text between the FUNCTION-DEFINITION occurrence of
 * `startMarker` and the function-definition occurrence of `endMarker`. The
 * function-definition form is `${marker}:` (the property syntax). This
 * avoids matching comment text that uses the same name (e.g.
 * `// - afterAcceptInvitation: fires when ...`) and only matches the
 * actual hook callback.
 */
function sliceHookBlock(
	source: string,
	startMarker: string,
	endMarker: string,
) {
	const startPattern = new RegExp(
		`${escapeRegex(startMarker)}\\s*:\\s*async`,
	);
	const startMatch = source.match(startPattern);
	expect(
		startMatch,
		`expected to find "${startMarker}: async" property in auth.ts`,
	).not.toBeNull();
	const startIdx = startMatch!.index!;

	// endMarker can be another hook (`afterAddMember`) or a sibling plugin
	// (`openAPI`). Search for either form, whichever appears first after
	// startIdx.
	const endPropertyPattern = new RegExp(
		`${escapeRegex(endMarker)}\\s*:\\s*async`,
	);
	const endPluginPattern = new RegExp(`\\b${escapeRegex(endMarker)}\\s*\\(`);
	const tail = source.slice(startIdx + startMarker.length);
	const endPropertyMatch = tail.match(endPropertyPattern);
	const endPluginMatch = tail.match(endPluginPattern);
	let endRelative = Number.POSITIVE_INFINITY;
	if (endPropertyMatch && typeof endPropertyMatch.index === "number") {
		endRelative = endPropertyMatch.index;
	}
	if (
		endPluginMatch &&
		typeof endPluginMatch.index === "number" &&
		endPluginMatch.index < endRelative
	) {
		endRelative = endPluginMatch.index;
	}
	expect(
		endRelative,
		`expected to find "${endMarker}" property or call after "${startMarker}" in auth.ts`,
	).not.toBe(Number.POSITIVE_INFINITY);
	return source.slice(startIdx, startIdx + startMarker.length + endRelative);
}

function escapeRegex(input: string) {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
