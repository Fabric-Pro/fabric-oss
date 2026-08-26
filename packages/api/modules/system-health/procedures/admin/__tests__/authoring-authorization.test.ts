/**
 * Only a platform admin may author customer-facing status announcements.
 *
 * This text is published to every customer of the deployment, so the gate is the
 * most security-relevant thing about these three procedures — and it had no test.
 * The checklist item for it was marked "needs a second, non-admin staging account",
 * which was the wrong conclusion: a live click-through proves it once, on one
 * deployment, and cannot catch a regression. This proves it on every run.
 *
 * **It tests the real shipped middleware, not a copy of its logic.**
 * `adminProcedure` is `protectedProcedure` plus exactly one middleware, so the last
 * entry in its chain IS the gate. The test pulls that function out and invokes it,
 * then asserts each authoring procedure's own chain contains *that same function
 * object*. Restating the `role !== "admin"` check locally would pass forever even
 * if a procedure were switched to `protectedProcedure`, which is the realistic
 * regression.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	adminProcedure,
	protectedProcedure,
} from "../../../../../orpc/procedures";
import { appendStatusRevisionProcedure } from "../append-revision";
import { listStatusUpdatesAdminProcedure } from "../list";
import { publishStatusUpdateProcedure } from "../publish";

/** oRPC middleware signature: (options, input, output). Only options is read. */
type Middleware = (options: {
	context: unknown;
	next: (...args: unknown[]) => unknown;
}) => Promise<unknown>;

function middlewaresOf(procedure: unknown): Middleware[] {
	return (procedure as { "~orpc": { middlewares: Middleware[] } })["~orpc"]
		.middlewares;
}

/**
 * The admin gate: the single middleware `adminProcedure` adds on top of
 * `protectedProcedure`. Derived rather than hardcoded by index, so the extraction
 * itself is checked below.
 */
const adminChain = middlewaresOf(adminProcedure);
const protectedChain = middlewaresOf(protectedProcedure);
const adminGate = adminChain[adminChain.length - 1] as Middleware;

const AUTHORING_PROCEDURES = [
	["statusUpdates.publish", publishStatusUpdateProcedure],
	["statusUpdates.appendRevision", appendStatusRevisionProcedure],
	["statusUpdates.listAdmin", listStatusUpdatesAdminProcedure],
] as const;

const next = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	next.mockResolvedValue({ output: "reached the handler" });
});

describe("the admin gate itself", () => {
	it("is exactly one middleware more than protectedProcedure", () => {
		// Guards the extraction above. If `adminProcedure` gained a second
		// middleware, `adminGate` would silently become the wrong function and
		// every assertion below would test something else.
		expect(adminChain.length).toBe(protectedChain.length + 1);
		expect(protectedChain.every((mw, i) => adminChain[i] === mw)).toBe(
			true,
		);
		expect(typeof adminGate).toBe("function");
	});

	it("refuses a non-admin with FORBIDDEN and never reaches the handler", async () => {
		await expect(
			adminGate({ context: { user: { id: "u1", role: "user" } }, next }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(next).not.toHaveBeenCalled();
	});

	it("refuses a user with no role at all", async () => {
		// A user record missing `role` must fail closed, not fall through.
		await expect(
			adminGate({ context: { user: { id: "u1" } }, next }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(next).not.toHaveBeenCalled();
	});

	it.each(["Admin", "ADMIN", "administrator", "superadmin", ""])(
		"refuses role %o — the check is exact",
		async (role) => {
			// Documents that the comparison is strict equality on "admin". A
			// case-insensitive or prefix match would let these through.
			await expect(
				adminGate({ context: { user: { id: "u1", role } }, next }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		},
	);

	it("lets a platform admin through", async () => {
		await expect(
			adminGate({ context: { user: { id: "u1", role: "admin" } }, next }),
		).resolves.toEqual({ output: "reached the handler" });

		expect(next).toHaveBeenCalledTimes(1);
	});
});

describe("every authoring procedure is behind that same gate", () => {
	// The link that makes the tests above meaningful for THESE procedures.
	// Identity comparison, not a name or a count: switching one to
	// `protectedProcedure` drops the function and fails here.
	for (const [name, procedure] of AUTHORING_PROCEDURES) {
		it(`${name} carries the admin gate`, () => {
			expect(middlewaresOf(procedure)).toContain(adminGate);
		});
	}

	it("covers every procedure in the admin authoring directory", async () => {
		// A fourth authoring procedure added later must be added here too,
		// otherwise it ships ungated and nothing notices.
		const { readdirSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		const files = readdirSync(resolve(__dirname, "..")).filter(
			(f) => f.endsWith(".ts") && !f.startsWith("index"),
		);
		expect(files.sort()).toEqual([
			"append-revision.ts",
			"list.ts",
			"publish.ts",
		]);
		expect(AUTHORING_PROCEDURES).toHaveLength(files.length);
	});
});
