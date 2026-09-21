/**
 * Canary for the private oRPC shape the activity-capture middleware reads.
 *
 * `readDeclaredMethod` and `readActivityCaptureMeta` reflect on
 * `procedure["~orpc"]` — the `~` prefix is oRPC's own marker for "internal,
 * not covered by semver". The unit tests next door feed those readers
 * hand-rolled literals, so they cannot notice when an upstream release moves
 * `route` or `meta` somewhere else. And because an unreadable method degrades
 * to "capture it", the failure would be silent over-auditing — extra ledger
 * rows for reads — never a crash.
 *
 * So this file reads the shape off REAL procedures: two taken from the router
 * as written (one declaring GET, one declaring POST) and two built through the
 * repository's own base builders, which is the only place the `auditActivity`
 * meta vocabulary is declared. A dependency bump that restructures
 * `ProcedureDef` turns this red instead of quietly changing audit volume.
 *
 * If this fails after an oRPC upgrade, fix the two readers in
 * `../audit-activity-middleware.ts`; do not loosen these assertions.
 */

import { os } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual };
});

// `protectedProcedure` imports lazily from `@repo/payments` only on the
// catch path of the AI-usage-limit error mapper, but the procedures module
// re-exports its types eagerly. Stub the package so module load stays cheap.
vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class {},
}));

import { listUsers } from "../../../modules/admin/procedures/list-users";
import { createProjectProcedure } from "../../../modules/projects/procedures/create-project";
import { publicProcedure } from "../../procedures";
import {
	readActivityCaptureMeta,
	readDeclaredMethod,
} from "../audit-activity-middleware";

describe("~orpc shape canary: declared method", () => {
	it("reads GET off a real router procedure that declares it", () => {
		expect(readDeclaredMethod(listUsers)).toBe("GET");
	});

	it("reads POST off a real router procedure that declares it", () => {
		expect(readDeclaredMethod(createProjectProcedure)).toBe("POST");
	});

	it("reads a method off a procedure built by the bare oRPC builder", () => {
		// No repository middleware in the chain: if this one fails, the library
		// itself moved `route`, not our wrapping of it.
		const procedure = os.route({ method: "GET" }).handler(() => null);
		expect(readDeclaredMethod(procedure)).toBe("GET");
	});

	it("returns undefined for a real procedure that declares no method", () => {
		const procedure = publicProcedure.handler(() => null);
		expect(readDeclaredMethod(procedure)).toBeUndefined();
	});
});

describe("~orpc shape canary: auditActivity meta", () => {
	it("reads the declaration off a procedure built by the repository's base builder", () => {
		const never = publicProcedure
			.meta({ auditActivity: "never" })
			.handler(() => null);
		const always = publicProcedure
			.meta({ auditActivity: "always" })
			.handler(() => null);
		expect(readActivityCaptureMeta(never)).toBe("never");
		expect(readActivityCaptureMeta(always)).toBe("always");
	});

	it("reads the declaration off a procedure built by the bare oRPC builder", () => {
		const procedure = os
			.$meta<{ auditActivity?: "always" | "never" }>({})
			.meta({ auditActivity: "never" })
			.handler(() => null);
		expect(readActivityCaptureMeta(procedure)).toBe("never");
	});

	it("returns undefined for real router procedures that declare nothing", () => {
		// No procedure in the repository declares the override today, so the
		// automatic rule is what governs these; the canary pins that the reader
		// sees "nothing declared" rather than a stray value from the meta bag.
		expect(readActivityCaptureMeta(listUsers)).toBeUndefined();
		expect(readActivityCaptureMeta(createProjectProcedure)).toBeUndefined();
	});
});
