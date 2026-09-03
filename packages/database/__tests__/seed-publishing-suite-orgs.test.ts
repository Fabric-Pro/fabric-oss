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

	// This is a cost-and-exposure notice an operator reads mid-deploy, so the
	// test pins the CURRENT truth in one unit, and pins both directions the
	// wording has been wrong in before.
	//
	// Over-warning: claiming the daily sweep starts spending from the next
	// tick. False — the sweep filters to non-MANUAL scheduled ids only, and
	// nothing sets a project's cadence automatically.
	//
	// Under-warning, the worse direction on a cost path: implying NO cost
	// accrues until a cadence changes. False — the manual "Generate now" route
	// (generate-now.ts) checks ONLY the PUBLISHING_SUITE flag. Cadence was
	// never one of `requestPublishingGeneration`'s "BOTH spend guards" that a
	// forced run bypasses; it is a sweep-selection filter, never re-derived on
	// the manual path. Any project in a newly enrolled organization can spend
	// on demand immediately, MANUAL or not.
	//
	// Slice 3 changed what enrolment does, and the correction has to land in
	// the middle of two failure modes rather than at one end.
	//
	// The retired wording said enrolment changed nothing an operator could see,
	// because a separate build-time flag kept the deep-link page 404ing and the
	// Settings sub-tab hidden. That flag is gone, so the warning must name what
	// enrolment now opens: the deep-link page, the Settings sub-tab, the API.
	//
	// This test used to ALSO pin a "the tab stays hidden" clause, because
	// `publishing-suite` sat in `PROJECT_TAB_DEFAULT_HIDDEN_IDS` and a project
	// admin had to force-show it. Card #1837's follow-up retired that set: a
	// project shows every tab the deployment offers, so enrolment now switches
	// the tab on across every project the organization owns. The clause worth
	// pinning is the opposite one, and it is pinned in BOTH directions — the
	// new claim present, the retired one absent — because under-warning an
	// operator about a fleet-wide UI change is the expensive failure here.
	it("names the surfaces enrolment opens, says the project tab now appears across every project, and states both spend paths, before writing", async () => {
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
		// The surfaces enrolment actually opens, named individually rather
		// than summarised as "visible".
		expect(noteEvent).toMatch(/deep-link/i);
		expect(noteEvent).toMatch(/settings/i);
		// ...including the project tab, which is now the loudest surface of
		// all: it appears across every project the organization owns.
		expect(noteEvent).toMatch(/tab/i);
		expect(noteEvent).toMatch(/every project/i);
		// The retired "stays hidden" clause must not survive: it now
		// under-warns, which is the expensive direction for an operator.
		expect(noteEvent).not.toMatch(/tab.*stays hidden|tab.*remains hidden/i);
		// The original "nothing is visible yet" wording must not survive
		// either. Pinned as PHRASES, not words: the accurate warning
		// legitimately contains "404" (the deep-link page stops 404ing), so a
		// word-level ban would have forbidden the correct text. These three
		// are the retired claim's own sentences.
		expect(noteEvent).not.toMatch(
			/nothing is visible|nothing to see|not visible yet/i,
		);
		expect(noteEvent).not.toMatch(
			/Settings tab that sets cadence|behind the separate|seed cannot touch/i,
		);
		expect(noteEvent).not.toMatch(/NEXT_PUBLIC/);
		// Must name the manual-generate exposure — the immediate,
		// cadence-independent spend path.
		expect(noteEvent).toMatch(/generate now/i);
		// Must NOT claim cost is gated on cadence generally.
		expect(noteEvent).not.toMatch(/no cost accrues until/i);
		// The sweep's OWN gate must still be stated accurately.
		expect(noteEvent).toMatch(/sweep/i);
		expect(noteEvent).toMatch(/MANUAL/);
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
