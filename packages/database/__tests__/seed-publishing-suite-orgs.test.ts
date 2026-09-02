/**
 * The enrolment seed's decision logic, exercised without a database.
 *
 * The properties that matter are all about what the seed REFUSES to do: write
 * for an id that matches nothing, echo an id into an error, or overwrite a row
 * an operator has already set. The second describe block below (DEC-14) goes
 * further: it exercises `main()`'s own real write wiring, not a hand-written
 * double, against a stubbed Prisma delegate.
 */
import { describe, expect, it, vi } from "vitest";
import {
	buildSeedDeps,
	enrolOrganizations,
} from "../prisma/seed-publishing-suite-orgs";

describe("enrolOrganizations", () => {
	it("is a no-op when the variable is unset or empty", async () => {
		const createOverrides = vi.fn();
		await expect(
			enrolOrganizations(undefined, {
				findOrganizations: vi.fn(),
				createOverrides,
				log: () => {},
			}),
		).resolves.toBe(0);
		expect(createOverrides).not.toHaveBeenCalled();

		await expect(
			enrolOrganizations("  ,  ,", {
				findOrganizations: vi.fn(),
				createOverrides,
				log: () => {},
			}),
		).resolves.toBe(0);
		expect(createOverrides).not.toHaveBeenCalled();
	});

	it("writes nothing when any id matches no organization", async () => {
		const createOverrides = vi.fn();
		await expect(
			enrolOrganizations("org_real,org_typo", {
				findOrganizations: async () => [{ id: "org_real" }],
				createOverrides,
				log: () => {},
			}),
		).rejects.toThrow(/1 id\(s\) match no organization/);
		// The valid id must not be enrolled either — the check is all-or-nothing.
		expect(createOverrides).not.toHaveBeenCalled();
	});

	// This repository is public and these ids identify real customers.
	it("never echoes an id into the error message", async () => {
		await expect(
			enrolOrganizations("org_secret_identifier", {
				findOrganizations: async () => [],
				createOverrides: vi.fn(),
				log: () => {},
			}),
		).rejects.toThrow(
			expect.objectContaining({
				message: expect.not.stringContaining("org_secret_identifier"),
			}),
		);
	});

	// The one dependency-error case this suite pins: a rejection from an
	// injected dependency must never let its own message (which, for a real
	// Prisma validation error, echoes the whole argument object — including
	// the ids) reach the caller.
	it("does not leak a dependency error's message to the caller", async () => {
		class OpaquePrismaLikeError extends Error {
			code = "P2002";
			constructor() {
				super(
					"Invalid `db.organization.findMany()` invocation: { where: { id: { in: ['org_secret_identifier'] } } }",
				);
				this.name = "PrismaClientValidationError";
			}
		}

		await expect(
			enrolOrganizations("org_secret_identifier", {
				findOrganizations: async () => {
					throw new OpaquePrismaLikeError();
				},
				createOverrides: vi.fn(),
				log: () => {},
			}),
		).rejects.toThrow(
			expect.objectContaining({
				message: expect.not.stringContaining("org_secret_identifier"),
			}),
		);
	});

	it("enrols all known ids in a single write", async () => {
		const createOverrides = vi.fn(async () => ({ count: 2 }));
		await expect(
			enrolOrganizations("org_1, org_2", {
				findOrganizations: async () => [
					{ id: "org_1" },
					{ id: "org_2" },
				],
				createOverrides,
				log: () => {},
			}),
		).resolves.toBe(2);
		expect(createOverrides).toHaveBeenCalledTimes(1);
		expect(createOverrides).toHaveBeenCalledWith(["org_1", "org_2"]);
	});

	// The property the whole create-not-upsert choice exists for: a row an
	// operator has deliberately turned off must survive the next deploy.
	// `createMany` with `skipDuplicates` reports it as not-inserted, so the
	// count returned is 0 out of the 1 id enrolled.
	it("reports an existing row as unchanged rather than counting it", async () => {
		const log = vi.fn();
		await expect(
			enrolOrganizations("org_1", {
				findOrganizations: async () => [{ id: "org_1" }],
				createOverrides: async () => ({ count: 0 }),
				log,
			}),
		).resolves.toBe(0);
		expect(log).toHaveBeenCalledWith(expect.stringContaining("0 of 1"));
	});

	// The warning went through three rounds, wrong in three different ways —
	// which is why this comment is written as ONE unit describing the CURRENT
	// truth, not as a stack of "round N said X, round N+1 corrected it"
	// paragraphs (round 3 flagged exactly that pattern in this file: two
	// adjacent paragraphs that each stood alone and contradicted each other).
	//
	// Round 1 over-warned: "starts the daily sweep and its model-inference
	// cost … from the next scheduled tick" — false, because the sweep filters
	// to non-MANUAL scheduled ids only and nothing sets a project's cadence
	// automatically.
	//
	// Round 2 corrected the sweep claim but under-warned in the process,
	// on a cost path where under-warning is the worse direction: it implied
	// NO cost accrues until cadence changes, and mislabeled the settings tab
	// (which is merely HIDDEN — client-side tab state with no route to 404 —
	// filtered out of ProjectSettingsNav's tab list) as the thing that 404s.
	// The 404 belongs to the deep-link Publishing page, a different surface.
	//
	// Round 3's fact, verified against source rather than restated: enrolment
	// opens TWO doors. The manual "Generate now" route
	// (generate-now.ts) checks ONLY the PUBLISHING_SUITE flag — cadence was
	// never one of `requestPublishingGeneration`'s "BOTH spend guards" a
	// forced run bypasses; it is a sweep-selection filter only, never
	// re-derived on the manual path. So any project in a newly enrolled
	// organization can spend on demand immediately, MANUAL or not. The daily
	// sweep alone is the narrower, cadence-gated door.
	it("warns about the immediate manual-generate exposure and the narrower sweep gate, before writing", async () => {
		const events: string[] = [];
		const createOverrides = vi.fn(async () => {
			events.push("write");
			return { count: 1 };
		});
		const log = vi.fn((message: string) => {
			events.push(`log:${message}`);
		});

		await enrolOrganizations("org_1", {
			findOrganizations: async () => [{ id: "org_1" }],
			createOverrides,
			log,
		});

		const noteEvent = events.find((e) => e.includes("WARNING"));
		expect(noteEvent).toBeDefined();
		// Must name the manual-generate exposure — the immediate,
		// cadence-independent spend path both earlier rounds omitted.
		expect(noteEvent).toMatch(/generate now/i);
		// Must NOT claim cost is gated on cadence generally — that was
		// round 2's under-warning defect.
		expect(noteEvent).not.toMatch(/no cost accrues until/i);
		// The sweep's OWN gate must still be stated accurately.
		expect(noteEvent).toMatch(/sweep/i);
		expect(noteEvent).toMatch(/MANUAL/);
		// The settings tab is HIDDEN, not 404 — the 404 belongs to the
		// deep-link page, a different surface. Pin each claim to its correct
		// surface directly, rather than a negative regex trying to rule out
		// every wrong pairing (a round-2-style mislabel can survive a bare
		// `.not.toMatch(/settings.*404/)` simply by having a sentence
		// boundary or word order the regex did not anticipate).
		expect(noteEvent).toMatch(/deep-link.*404|404.*deep-link/i);
		expect(noteEvent).toMatch(/settings tab.*hidden|hidden.*settings tab/i);
		// "Before it writes": the warning event must precede the write
		// event, not merely the final summary log that follows the write.
		expect(events.indexOf(noteEvent as string)).toBeLessThan(
			events.indexOf("write"),
		);
	});

	it("does not log a note or write when the variable is unset", async () => {
		const log = vi.fn();
		const createOverrides = vi.fn();
		await enrolOrganizations(undefined, {
			findOrganizations: vi.fn(),
			createOverrides,
			log,
		});
		expect(createOverrides).not.toHaveBeenCalled();
		for (const call of log.mock.calls) {
			expect(call[0]).not.toContain("NOTE");
		}
	});
});

// DEC-14: non-resurrection is "the one property worth a test" — a seed that
// resurrects a deliberately disabled organization on the next deploy is the
// kind of bug that surfaces months later, on a customer's flag an admin
// turned off on purpose.
//
// Every case above drives `enrolOrganizations` with a HAND-WRITTEN
// `createOverrides` double, so none of them would notice if `main()`'s REAL
// wiring changed shape — to an `upsert` loop, or to a second write appended
// after the `createMany`. This suite exercises `buildSeedDeps()`, the exact
// factory `main()` calls, against a STUBBED Prisma delegate: no database is
// reachable here, but this is a BEHAVIOURAL assertion, not a source-text
// one — a source-text scan proved too fragile in review (a `.upsert(`
// string ban survives a rename to `updateMany`, and a slice boundary keyed
// to a nearby comment string breaks on any reword near it, red for a
// change with no behavioural difference at all). The stub is a `Proxy`
// that records every method invoked on `organizationFeatureFlagOverride`,
// so the assertion is "exactly one call, and it is `createMany` with
// `skipDuplicates: true`" — which catches an `upsert` swap, an
// `updateMany` swap, AND a second write appended after a correct
// `createMany`, none of which a method-name string match alone would.
describe("buildSeedDeps() — main()'s real write path, exercised behaviourally", () => {
	/**
	 * Records every method called on `organizationFeatureFlagOverride`
	 * without asserting anything about WHICH methods a correct
	 * implementation may use — the test does that. `createMany` resolves
	 * with a count so `enrolOrganizations`'s own return-value logging has
	 * something real to report; every other method resolves `undefined`,
	 * which is enough for a call to be observed and is never reached by a
	 * correct implementation in the first place.
	 */
	function trackedOverrideDelegate(): {
		delegate: Record<string, (...args: unknown[]) => Promise<unknown>>;
		calls: Array<{ method: string; args: unknown[] }>;
	} {
		const calls: Array<{ method: string; args: unknown[] }> = [];
		const delegate = new Proxy(
			{},
			{
				get(_target, prop: string) {
					return (...args: unknown[]) => {
						calls.push({ method: prop, args });
						if (prop === "createMany") {
							const data = (
								args[0] as { data?: unknown[] } | undefined
							)?.data;
							return Promise.resolve({
								count: Array.isArray(data) ? data.length : 0,
							});
						}
						return Promise.resolve(undefined);
					};
				},
			},
		) as Record<string, (...args: unknown[]) => Promise<unknown>>;
		return { delegate, calls };
	}

	it("calls createMany({ skipDuplicates: true }) and nothing else on the delegate", async () => {
		const { delegate, calls } = trackedOverrideDelegate();
		const deps = buildSeedDeps({
			organization: {
				findMany: async () => [{ id: "org_1" }, { id: "org_2" }],
			},
			organizationFeatureFlagOverride: delegate,
		} as any);

		const result = await deps.createOverrides(["org_1", "org_2"]);

		expect(result).toEqual({ count: 2 });
		// The whole point: exactly ONE call reached the delegate. An
		// `upsert`-loop, an `updateMany` swap, or a second write appended
		// after a correct `createMany` all show up here as more than one
		// call (or the wrong method name), where a bare
		// `.not.toMatch(/\.upsert\(/)` string check would miss every
		// variant except the one literal spelling it names.
		expect(calls).toHaveLength(1);
		expect(calls[0].method).toBe("createMany");
		expect(calls[0].args[0]).toEqual({
			data: [
				{
					key: "PUBLISHING_SUITE",
					organizationId: "org_1",
					enabled: true,
					updatedBy: "seed:publishing-suite-orgs",
				},
				{
					key: "PUBLISHING_SUITE",
					organizationId: "org_2",
					enabled: true,
					updatedBy: "seed:publishing-suite-orgs",
				},
			],
			skipDuplicates: true,
		});
	});

	it("findOrganizations reads through to organization.findMany unchanged", async () => {
		const findMany = vi.fn(async () => [{ id: "org_1" }]);
		const deps = buildSeedDeps({
			organization: { findMany },
			organizationFeatureFlagOverride: trackedOverrideDelegate().delegate,
		} as any);

		await expect(deps.findOrganizations(["org_1"])).resolves.toEqual([
			{ id: "org_1" },
		]);
		expect(findMany).toHaveBeenCalledWith({
			where: { id: { in: ["org_1"] } },
			select: { id: true },
		});
	});
});
