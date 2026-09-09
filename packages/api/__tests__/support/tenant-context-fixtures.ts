/**
 * Shared scaffolding for the `tenantContextMiddleware` regression suites
 * (Fizzy #2403).
 *
 * `tenant-context-missing-workspace.test.ts` and
 * `tenant-context-missing-membership.test.ts` landed in the same change,
 * written from the same template, and carried byte-for-byte identical copies of
 * everything below: the `mocks` object, the `@repo/logs` stub built from it,
 * `loadMiddleware`, the three id constants and `invokeMw`. One copy, so a
 * change to how the middleware is invoked cannot land in one suite and be
 * missed in the other. Follows `_harness.ts` under
 * `modules/agents/procedures/conversations/document-assistant/__tests__/`,
 * which does the same for ten siblings.
 *
 * What deliberately does NOT live here: each suite's own `Ctx` / `makeCtx` (the
 * missing-workspace one carries a `requestUrl` and an email its leak assertions
 * look for) and each suite's own `@repo/database` mock factory (the
 * missing-membership one adds `getOrganizationMembership` / `grantProjectAccess`
 * because it also imports `require-permission.ts`). Those differences are the
 * point of the two files being two files, and generalising them behind options
 * would hide it.
 *
 * The `@repo/logs` stub is registered when this module is evaluated. Both
 * suites reach the logger only through `loadMiddleware`, which imports the
 * middleware dynamically from inside a test, so the stub is always in place by
 * the time anything asks for it.
 */

import { getTenantContext } from "@repo/database/src/tenant-context";
import { vi } from "vitest";

/**
 * The two stubs both suites drive the middleware with.
 *
 * A plain object rather than `vi.hoisted`: vitest refuses to export a hoisted
 * binding ("Cannot export hoisted variable"). Nothing needs it hoisted — every
 * `vi.mock` factory that reads it, here and in the two suites, runs lazily when
 * its module is first imported, which is long after this module's body.
 */
export const mocks = {
	memberFindUnique: vi.fn(),
	warn: vi.fn(),
};

vi.mock("@repo/logs", () => ({
	logger: {
		warn: mocks.warn,
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

export async function loadMiddleware() {
	const mod = await import("../../orpc/middleware/tenant-context-middleware");
	return mod.tenantContextMiddleware;
}

export const USER_ID = "user-2403";
export const ORG_ID = "org-2403";
export const PROCEDURE_PATH = ["prompts", "deletionImpact"] as const;

// oRPC returns the tagged middleware as a callable — invoke it directly with
// ({ context, next, path }, input). Mirrors require-input-org-permission.test.ts.
export async function invokeMw<TCtx>(
	mw: unknown,
	ctx: TCtx,
	path: readonly string[] = PROCEDURE_PATH,
) {
	let seenTenantContextInsideRun: unknown;
	const next = vi.fn(async (opts?: { context?: Record<string, unknown> }) => {
		// Assert from INSIDE the wrapped run: the middleware is supposed to
		// execute the rest of the chain within `runWithTenantContext`.
		seenTenantContextInsideRun = getTenantContext();
		return { output: "ok", context: opts?.context };
	});

	const result = await (
		mw as (
			arg: {
				context: TCtx;
				next: typeof next;
				path: readonly string[];
			},
			input: unknown,
		) => Promise<unknown>
	)({ context: ctx, next, path }, {});

	return { next, result, seenTenantContextInsideRun };
}
