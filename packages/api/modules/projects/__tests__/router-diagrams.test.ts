/**
 * Router contract test for `projects.diagrams.createFromChat`.
 *
 * Asserts that B3 wired the new createFromChatProcedure into the
 * projects router's `diagrams` sub-router so the oRPC client surface
 * is reachable with full type inference.
 *
 * We avoid importing the full `projectsRouter` (~165 import lines, each
 * pulling in @repo/database / @repo/permissions etc.) and instead:
 *   1. Import the procedure module to confirm it loads and the
 *      handler is captured by the chainable mock.
 *   2. Read the router.ts source as text and assert the diagrams
 *      sub-router contains `createFromChat: createFromChatProcedure`
 *      (the exact wiring the spec § 7.1 mandates).
 *
 * This keeps the test fast (no Prisma boot) while still failing loudly
 * if a future refactor drops the registration.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const { mockRequireProjectPermission } = vi.hoisted(() => ({
	mockRequireProjectPermission: vi.fn(() => ({})),
}));

vi.mock("@repo/database", () => ({
	createDiagram: vi.fn(),
}));

vi.mock("@repo/observability", () => ({
	incrementDiagramAutoInsertedCounter: vi.fn(),
}));

vi.mock("../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({
			_handler: fn,
			_isCapturedProcedure: true,
		}),
	});
	return {
		tenantProtectedProcedure: chainable,
		resolveOrganizationId: vi.fn(),
		requireProjectPermission: (perm: string) =>
			mockRequireProjectPermission(perm),
		Permissions: new Proxy({}, { get: (_: unknown, prop: string) => prop }),
	};
});

describe("projects router — diagrams.createFromChat registration", () => {
	it("loads the createFromChatProcedure module", async () => {
		const mod = await import("../procedures/diagrams/create-from-chat");
		expect(mod.createFromChatProcedure).toBeDefined();
		expect(
			(mod.createFromChatProcedure as { _isCapturedProcedure?: boolean })
				._isCapturedProcedure,
		).toBe(true);
	});

	it("router.ts imports createFromChatProcedure from the diagrams folder", () => {
		const routerSource = readFileSync(
			resolve(__dirname, "../router.ts"),
			"utf8",
		);
		expect(routerSource).toContain(
			'import { createFromChatProcedure } from "./procedures/diagrams/create-from-chat";',
		);
	});

	it("router.ts wires diagrams.createFromChat: createFromChatProcedure", () => {
		const routerSource = readFileSync(
			resolve(__dirname, "../router.ts"),
			"utf8",
		);
		// Allow flexible whitespace but require the exact key/value pair.
		expect(routerSource).toMatch(
			/createFromChat:\s*createFromChatProcedure/,
		);
	});

	it("router.ts keeps diagrams sub-router ordering: list, get, create, createFromChat, update, delete", () => {
		const routerSource = readFileSync(
			resolve(__dirname, "../router.ts"),
			"utf8",
		);
		const diagramsBlock = routerSource.match(/diagrams:\s*\{([^}]+)\}/m);
		expect(diagramsBlock).not.toBeNull();
		const body = diagramsBlock?.[1] ?? "";

		const idx = (key: string) => body.indexOf(`${key}:`);
		expect(idx("list")).toBeGreaterThanOrEqual(0);
		expect(idx("get")).toBeGreaterThan(idx("list"));
		expect(idx("create")).toBeGreaterThan(idx("get"));
		expect(idx("createFromChat")).toBeGreaterThan(idx("create"));
		expect(idx("update")).toBeGreaterThan(idx("createFromChat"));
		expect(idx("delete")).toBeGreaterThan(idx("update"));
	});
});
