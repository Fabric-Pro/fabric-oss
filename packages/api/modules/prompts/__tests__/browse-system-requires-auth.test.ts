/**
 * `prompts.browse.system` must require a session.
 *
 * It was built on `publicProcedure`, and the `requirePermission(PROMPT_READ)`
 * next to it did nothing: that middleware returns `next()` unconditionally when
 * `context.tenantContext` is unset, and `publicProcedure` never sets it. So the
 * call read as guarded and was not.
 *
 * Verified against the deployed app before this change: an unauthenticated GET
 * of `/api/rpc/prompts/browse/system` returned HTTP 200 with every system prompt
 * and its full text. No customer data — every row is scope SYSTEM with null
 * user and organization — but the prompts themselves are not public material,
 * and nothing in any Fabric repository calls this endpoint.
 *
 * This asserts which builder the procedure is constructed from, because that is
 * the property that was wrong. A handler-level test cannot see it: the handler
 * body is identical either way, and it is the builder that decides whether a
 * request without a session ever reaches it.
 */

import { describe, expect, it, vi } from "vitest";

const { publicBuilder, protectedBuilder } = vi.hoisted(() => {
	const make = (name: string) => {
		const builder: any = {
			__builder: name,
			use: () => builder,
			route: () => builder,
			input: () => builder,
			output: () => builder,
			// The finished procedure carries the builder that made it.
			handler: () => ({ __builtFrom: name }),
		};
		return builder;
	};
	return {
		publicBuilder: make("publicProcedure"),
		protectedBuilder: make("tenantProtectedProcedure"),
	};
});

vi.mock("@repo/database", () => ({
	listSystemPrompts: vi.fn(),
	listPromptsForTenant: vi.fn(),
}));

vi.mock("../../../orpc/procedures", () => ({
	Permissions: { PROMPT_READ: "prompt:read" },
	requirePermission: () => (n: unknown) => n,
	requireInputOrgPermission: () => (n: unknown) => n,
	publicProcedure: publicBuilder,
	tenantProtectedProcedure: protectedBuilder,
}));

import { browseProcedures } from "../procedures/browse";

describe("prompts.browse.system authentication", () => {
	it("is not built on publicProcedure", () => {
		expect((browseProcedures.system as any).__builtFrom).not.toBe(
			"publicProcedure",
		);
	});

	it("is built on the tenant-protected builder", () => {
		expect((browseProcedures.system as any).__builtFrom).toBe(
			"tenantProtectedProcedure",
		);
	});

	it("leaves browse.mine protected too", () => {
		// Guard against a fix that swaps one and breaks the other.
		expect((browseProcedures.mine as any).__builtFrom).toBe(
			"tenantProtectedProcedure",
		);
	});
});
