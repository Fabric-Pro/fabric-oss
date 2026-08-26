/**
 * Writer tests for the two ProjectUserFunctionTag paths that use the
 * module-level `db` (Fizzy #2264, spec §5.2 / §5.7).
 *
 * In its OWN file because it hoists `vi.mock("../../../client", …)`. Same
 * reasoning as `function-tags-wiring.test.ts`: a file-wide module mock that
 * leaked into `function-tags.test.ts` would replace the real client for
 * `applyGlobalDefaultFunctionTags`' tests too.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
// Type-only, so it is erased before the module mock below matters.
import type { FunctionTag } from "../../../client";

const { dbMock, txMock } = vi.hoisted(() => {
	const txMock = {
		$queryRaw: vi.fn(),
		projectUserFunctionTag: {
			findUnique: vi.fn(),
			update: vi.fn(),
			upsert: vi.fn(),
			create: vi.fn(),
		},
	};
	return {
		txMock,
		dbMock: {
			$transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
				fn(txMock),
			),
			projectUserFunctionTag: {
				updateMany: vi.fn(),
				create: vi.fn(),
				findUnique: vi.fn(),
			},
			user: { findUnique: vi.fn() },
		},
	};
});

// `../../../client` from THIS directory, not `../../client`: the specifier is
// resolved relative to the test file (`queries/projects/__tests__/`), not to
// the module under test. A path that resolves to nothing registers a mock that
// matches nothing and fails silently — the writers then run against the real
// Prisma client. Same specifier `function-tags-wiring.test.ts:43` uses.
vi.mock("../../../client", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, db: dbMock };
});

const { confirmProjectUserFunctionTags, upsertProjectUserFunctionTags } =
	await import("../function-tags");

const ARGS = {
	projectId: "p1",
	userId: "u1",
	organizationId: "org1" as string | null,
};

beforeEach(() => {
	txMock.$queryRaw.mockReset().mockResolvedValue([]);
	txMock.projectUserFunctionTag.findUnique.mockReset();
	txMock.projectUserFunctionTag.update.mockReset();
	txMock.projectUserFunctionTag.upsert.mockReset();
	txMock.projectUserFunctionTag.create.mockReset();
	dbMock.projectUserFunctionTag.updateMany.mockReset();
	dbMock.projectUserFunctionTag.create.mockReset();
	// Reset the CONFIRM path's own read too. Left unreset it would keep
	// returning `undefined`, which is also what a missing read returns — so
	// the `previousTags` assertions below could not tell "read the row" from
	// "never read anything".
	dbMock.projectUserFunctionTag.findUnique.mockReset();
});

describe("upsertProjectUserFunctionTags (the admin path)", () => {
	it("takes the row lock BEFORE reading, with parameterized SQL", async () => {
		// Order matters: a COMPARE -> LOCK sequence loses the exact race this
		// lock exists to close. Technique mirrors
		// `queries/projects/newsletter.embed.test.ts:177-181`.
		txMock.projectUserFunctionTag.findUnique.mockResolvedValue({
			tags: ["DEVELOPER"],
			organizationId: "org1",
		});

		await upsertProjectUserFunctionTags({ ...ARGS, tags: ["ARCHITECT"] });

		expect(txMock.$queryRaw).toHaveBeenCalledTimes(1);
		expect(txMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
			txMock.projectUserFunctionTag.findUnique.mock
				.invocationCallOrder[0],
		);

		const parts = txMock.$queryRaw.mock.calls[0][0] as TemplateStringsArray;
		const sql = parts.join("?");
		expect(sql).toMatch(/FOR UPDATE/i);
		expect(sql).toContain('"project_user_function_tag"');
		// The ids ride as bind parameters, never in the SQL text.
		expect(sql).not.toContain("p1");
		expect(sql).not.toContain("u1");
	});

	it("a REAL change clears confirmedAt and increments the version", async () => {
		txMock.projectUserFunctionTag.findUnique.mockResolvedValue({
			tags: ["DEVELOPER"],
			organizationId: "org1",
		});

		const result = await upsertProjectUserFunctionTags({
			...ARGS,
			tags: ["ARCHITECT"],
		});

		expect(
			txMock.projectUserFunctionTag.upsert.mock.calls[0][0].update,
		).toMatchObject({
			tags: ["ARCHITECT"],
			confirmedAt: null,
			confirmationVersion: { increment: 1 },
		});
		// The bit the audit trail is conditional on. Asserted on the WRITING
		// path as well as the skipping one, because a `changed` hard-coded to
		// `false` would satisfy the no-op case alone.
		expect(result).toEqual({ changed: true });
	});

	it("a no-op (same set, different order, duplicates) SKIPS the write entirely", async () => {
		// Not "writes the same values" — skipping is the point. A write would
		// advance confirmationVersion and force an open confirmation prompt
		// into a spurious CONFLICT for an admin who changed nothing.
		txMock.projectUserFunctionTag.findUnique.mockResolvedValue({
			tags: ["DEVELOPER", "SME"],
			organizationId: "org1",
		});

		const result = await upsertProjectUserFunctionTags({
			...ARGS,
			tags: ["SME", "DEVELOPER", "DEVELOPER"],
		});

		expect(txMock.projectUserFunctionTag.upsert).not.toHaveBeenCalled();
		expect(txMock.projectUserFunctionTag.update).not.toHaveBeenCalled();
		// `changed: false` is what keeps the caller from recording an audit row
		// asserting a change that never happened.
		expect(result).toEqual({ changed: false });
	});

	it("clearing all tags clears confirmation — same rule, no special case", async () => {
		// AC13 asserted separately from AC12 even though one rule serves both,
		// so a future refactor that splits them is caught here.
		txMock.projectUserFunctionTag.findUnique.mockResolvedValue({
			tags: ["DEVELOPER"],
			organizationId: "org1",
		});

		await upsertProjectUserFunctionTags({ ...ARGS, tags: [] });

		expect(
			txMock.projectUserFunctionTag.upsert.mock.calls[0][0].update,
		).toMatchObject({ tags: [], confirmedAt: null });
	});

	it("an organizationId change alone is NOT a no-op", async () => {
		txMock.projectUserFunctionTag.findUnique.mockResolvedValue({
			tags: ["DEVELOPER"],
			organizationId: null,
		});

		await upsertProjectUserFunctionTags({ ...ARGS, tags: ["DEVELOPER"] });

		expect(txMock.projectUserFunctionTag.upsert).toHaveBeenCalledTimes(1);
	});

	it("a missing row goes through upsert, not a bare create", async () => {
		// SELECT … FOR UPDATE locks nothing when the row does not exist, so a
		// concurrent create can still win. Landing on the update branch is
		// correct; a bare create would be a 500.
		txMock.projectUserFunctionTag.findUnique.mockResolvedValue(null);

		await upsertProjectUserFunctionTags({ ...ARGS, tags: ["SME"] });

		expect(txMock.projectUserFunctionTag.upsert).toHaveBeenCalledTimes(1);
		expect(txMock.projectUserFunctionTag.create).not.toHaveBeenCalled();

		// WHICH METHOD was called is not the whole guarantee. The row this
		// branch creates is a member's FIRST row on the project, and it must be
		// born unconfirmed at version 0 — an admin assigning tags to someone
		// who has never had any cannot mark them as having already confirmed
		// tags they have never seen. That row would then never prompt them,
		// which is the exact AC12 state this feature exists to prevent, and no
		// trigger covers it: the trigger is BEFORE UPDATE only.
		const call = txMock.projectUserFunctionTag.upsert.mock.calls[0][0];
		expect(call.create).not.toHaveProperty("confirmedAt");
		expect(call.create).not.toHaveProperty("confirmationVersion");
	});
});

describe("confirmProjectUserFunctionTags", () => {
	// `as FunctionTag[]`, NOT `as const`: a readonly tuple is not assignable
	// to the mutable `FunctionTag[]` the signature takes. Vitest strips types
	// so `as const` runs green and only `tsc --noEmit` sees it.
	const BASE = { ...ARGS, tags: ["DEVELOPER"] as FunctionTag[] };

	it("refuses an empty tag set at the query layer (the §5.8 floor)", async () => {
		await expect(
			confirmProjectUserFunctionTags({
				...ARGS,
				tags: [],
				expectedVersion: 1,
			}),
		).rejects.toThrow(/at least one tag/i);
		expect(dbMock.projectUserFunctionTag.updateMany).not.toHaveBeenCalled();
	});

	it("a matching expectedVersion writes confirmedAt and increments", async () => {
		dbMock.projectUserFunctionTag.findUnique.mockResolvedValue({
			tags: ["SME"],
		});
		dbMock.projectUserFunctionTag.updateMany.mockResolvedValue({
			count: 1,
		});

		const result = await confirmProjectUserFunctionTags({
			...BASE,
			expectedVersion: 4,
		});

		// `previousTags` is the row's PRIOR set, not the confirmed one — an
		// audit row has to be able to tell a member accepting an
		// administrator's assignment from replacing it.
		expect(result).toEqual({
			outcome: "confirmed",
			tags: ["DEVELOPER"],
			previousTags: ["SME"],
			version: 5,
		});
		const call = dbMock.projectUserFunctionTag.updateMany.mock.calls[0][0];
		// `toEqual`, NOT `toMatchObject`: this is `updateMany`, so the WHERE is
		// the only thing scoping the write to one row. A partial assertion that
		// names only the version passes with `userId` removed — and that
		// statement would confirm one member's tags onto EVERY member of the
		// project sitting at the same version, then return `conflict` because
		// `count !== 1`, after the write had already landed.
		expect(call.where).toEqual({
			projectId: "p1",
			userId: "u1",
			confirmationVersion: 4,
		});
		expect(call.data).toMatchObject({
			tags: ["DEVELOPER"],
			confirmationVersion: { increment: 1 },
		});
		expect(call.data.confirmedAt).toBeInstanceOf(Date);
	});

	it("reads previousTags BEFORE the compare-and-set", async () => {
		// Reading after the CAS would report the tags the confirmation just
		// wrote as the tags it replaced — an audit row that says nothing
		// changed, every time.
		dbMock.projectUserFunctionTag.findUnique.mockResolvedValue({
			tags: ["SME"],
		});
		dbMock.projectUserFunctionTag.updateMany.mockResolvedValue({
			count: 1,
		});

		await confirmProjectUserFunctionTags({ ...BASE, expectedVersion: 4 });

		expect(
			dbMock.projectUserFunctionTag.findUnique.mock
				.invocationCallOrder[0],
		).toBeLessThan(
			dbMock.projectUserFunctionTag.updateMany.mock
				.invocationCallOrder[0],
		);
	});

	it("never writes organizationId on the update path", async () => {
		// A confirmation must not be able to move a row's tenancy. The row
		// already carries the org the admin path derived from the project.
		dbMock.projectUserFunctionTag.updateMany.mockResolvedValue({
			count: 1,
		});

		await confirmProjectUserFunctionTags({ ...BASE, expectedVersion: 4 });

		expect(
			dbMock.projectUserFunctionTag.updateMany.mock.calls[0][0].data,
		).not.toHaveProperty("organizationId");
	});

	it("count === 0 is a conflict, and nothing else is written", async () => {
		dbMock.projectUserFunctionTag.updateMany.mockResolvedValue({
			count: 0,
		});

		const result = await confirmProjectUserFunctionTags({
			...BASE,
			expectedVersion: 1,
		});

		expect(result).toEqual({ outcome: "conflict" });
		expect(dbMock.projectUserFunctionTag.create).not.toHaveBeenCalled();
	});

	it("expectedVersion null takes the create path at version 0", async () => {
		dbMock.projectUserFunctionTag.create.mockResolvedValue({});

		const result = await confirmProjectUserFunctionTags({
			...BASE,
			expectedVersion: null,
		});

		expect(result).toEqual({
			outcome: "confirmed",
			tags: ["DEVELOPER"],
			previousTags: [],
			version: 0,
		});
		const data = dbMock.projectUserFunctionTag.create.mock.calls[0][0].data;
		expect(data.confirmedAt).toBeInstanceOf(Date);
		// A fresh row starts at the schema default; the trigger is BEFORE
		// UPDATE only, so there is nothing to advance.
		expect(data).not.toHaveProperty("confirmationVersion");
		expect(dbMock.projectUserFunctionTag.updateMany).not.toHaveBeenCalled();
		// There is no prior row to read, so the branch costs no round-trip.
		expect(dbMock.projectUserFunctionTag.findUnique).not.toHaveBeenCalled();
	});

	it("a P2002 on the create path is a conflict, not a throw", async () => {
		dbMock.projectUserFunctionTag.create.mockRejectedValue({
			code: "P2002",
		});

		await expect(
			confirmProjectUserFunctionTags({ ...BASE, expectedVersion: null }),
		).resolves.toEqual({ outcome: "conflict" });
	});

	it("any OTHER create failure still throws", async () => {
		// The negative control for the branch above: swallowing every error
		// would turn a real database failure into a silent "someone else got
		// there first", and the member would be told to try again forever.
		dbMock.projectUserFunctionTag.create.mockRejectedValue({
			code: "P1001",
		});

		// The ORIGINAL error, not merely "something threw": `toBeTruthy` also
		// passes when the catch re-throws something else entirely, which would
		// lose the connection failure this branch exists to surface.
		await expect(
			confirmProjectUserFunctionTags({ ...BASE, expectedVersion: null }),
		).rejects.toMatchObject({ code: "P1001" });
	});
});
