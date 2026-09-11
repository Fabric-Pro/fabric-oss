/**
 * The CLI-connection prompt's decline (Fizzy #2457, R5).
 *
 * One property carries this unit and the tests are built around proving it:
 * the decline is keyed on the ORGANIZATION and the person, with no project in
 * it, so saying no once on one project answers the question on every other
 * project of that organization — including ones the person has never opened
 * (AE4). A per-project row would have looked identical at the call site and
 * asked a member of a ten-project organization the same question ten times.
 *
 * The `cliConnectionPromptDismissal` mock is therefore a small real store
 * rather than a `vi.fn()` returning a fixture: the point of the test is that
 * the row written on one project is the row FOUND from another, and only a
 * store that keys rows the way the schema does can show that.
 *
 * The second property is where the organization comes from. It is the
 * project's own, read through the evidence gatherer, and never the one in the
 * request — pairing a project you may read with an organization you may not is
 * how a cross-tenant write gets in.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface DismissalRow {
	organizationId: string;
	userId: string;
	dismissedAt: Date | null;
}

/** Keyed exactly as `@@unique([organizationId, userId])` is. */
const rows = new Map<string, DismissalRow>();
const rowKey = (where: { organizationId: string; userId: string }) =>
	`${where.organizationId}::${where.userId}`;

const { mockDb, mockIsFeatureEnabled, mockGather, mockResolveAccess } =
	vi.hoisted(() => ({
		mockDb: {
			cliConnectionPromptDismissal: {
				upsert: vi.fn(),
				findUnique: vi.fn(),
			},
		},
		mockIsFeatureEnabled: vi.fn(),
		mockGather: vi.fn(),
		mockResolveAccess: vi.fn(),
	}));

// Spread the real module rather than replacing it: importing the procedure
// pulls in the whole oRPC stack, which reaches other `@repo/database` exports
// through `@repo/payments`. A bare factory would strip those and fail at import
// time.
vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	db: mockDb,
	isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
}));

vi.mock("../../../lib/readiness/evidence", () => ({
	gatherReadinessEvidence: (...args: unknown[]) => mockGather(...args),
}));

// The resolver behind `requireProjectPermission`. Mocked so the declared gate
// can be exercised for real without a database.
vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...args: unknown[]) =>
		mockResolveAccess(...args),
}));

import {
	PERMISSION_MIDDLEWARE_TAG,
	Permissions,
} from "../../../../../orpc/procedures";
import { dismissCliNudgeProcedure } from "../dismiss-cli-nudge";

const ORG = "org-1";
const OTHER_ORG = "org-2";
const USER = "user-1";

/** Which organization each project belongs to, as the gatherer would report. */
const PROJECT_ORG: Record<string, string | null> = {
	"project-a": ORG,
	// A second project of the SAME organization — the AE4 case.
	"project-b": ORG,
	"project-elsewhere": OTHER_ORG,
	// The fail-closed default: a project whose tenant never resolved.
	"project-tenantless": null,
};

function dismiss(
	input: Record<string, unknown>,
	userId = USER,
): Promise<unknown> {
	// oRPC exposes the composed handler on the procedure definition; calling it
	// directly keeps this a unit test of the write rather than of oRPC.
	const handler = (
		dismissCliNudgeProcedure as unknown as {
			"~orpc": { handler: (opts: unknown) => Promise<unknown> };
		}
	)["~orpc"].handler;
	return handler({ input, context: { user: { id: userId }, session: {} } });
}

/**
 * The lookup the readiness read performs, expressed here exactly as `get.ts`
 * expresses it — organization and user, no project. Reading through it is what
 * makes the cross-project assertions mean something.
 */
async function readDismissal(projectId: string, userId = USER) {
	const organizationId = PROJECT_ORG[projectId];
	if (!organizationId) {
		return null;
	}
	return (await mockDb.cliConnectionPromptDismissal.findUnique({
		where: { organizationId_userId: { organizationId, userId } },
		select: { dismissedAt: true },
	})) as DismissalRow | null;
}

beforeEach(() => {
	vi.clearAllMocks();
	rows.clear();

	mockIsFeatureEnabled.mockResolvedValue(true);
	mockGather.mockImplementation(async (projectId: string) => {
		if (!(projectId in PROJECT_ORG)) {
			return null;
		}
		return {
			evidence: {},
			tenant: {
				userId: "owner-1",
				organizationId: PROJECT_ORG[projectId],
			},
		};
	});

	mockDb.cliConnectionPromptDismissal.upsert.mockImplementation(
		async (args: {
			where: {
				organizationId_userId: {
					organizationId: string;
					userId: string;
				};
			};
			create: DismissalRow;
			update: Partial<DismissalRow>;
		}) => {
			const key = rowKey(args.where.organizationId_userId);
			const existing = rows.get(key);
			const row = existing
				? { ...existing, ...args.update }
				: { ...args.create };
			rows.set(key, row);
			return row;
		},
	);
	mockDb.cliConnectionPromptDismissal.findUnique.mockImplementation(
		async (args: {
			where: {
				organizationId_userId: {
					organizationId: string;
					userId: string;
				};
			};
		}) => rows.get(rowKey(args.where.organizationId_userId)) ?? null,
	);

	mockResolveAccess.mockResolvedValue({
		permissions: [Permissions.PROJECT_READ],
		source: "org",
		organizationId: ORG,
	});
});

describe("projects.readiness.dismissCliNudge", () => {
	it("records the decline against the project's organization and the caller", async () => {
		await expect(dismiss({ projectId: "project-a" })).resolves.toEqual({
			ok: true,
		});

		expect(
			mockDb.cliConnectionPromptDismissal.upsert.mock.calls[0][0].where,
		).toEqual({
			organizationId_userId: { organizationId: ORG, userId: USER },
		});

		const stored = await readDismissal("project-a");
		expect(stored?.dismissedAt).toBeInstanceOf(Date);
		expect(rows.size).toBe(1);
	});

	it("is idempotent: a second decline leaves one row, still dismissed", async () => {
		await dismiss({ projectId: "project-a" });
		await dismiss({ projectId: "project-a" });

		expect(
			mockDb.cliConnectionPromptDismissal.upsert,
		).toHaveBeenCalledTimes(2);
		expect(rows.size).toBe(1);
		expect((await readDismissal("project-a"))?.dismissedAt).toBeInstanceOf(
			Date,
		);
	});

	it("stamps a row that already exists without a timestamp", async () => {
		// A row is an upsert target, so one can exist reading as NOT dismissed.
		// The update path has to write the timestamp, not leave it alone.
		rows.set(rowKey({ organizationId: ORG, userId: USER }), {
			organizationId: ORG,
			userId: USER,
			dismissedAt: null,
		});

		await dismiss({ projectId: "project-a" });

		expect(rows.size).toBe(1);
		expect((await readDismissal("project-a"))?.dismissedAt).toBeInstanceOf(
			Date,
		);
	});

	// AE4 — the reason this unit exists.
	it("answers the question on a different project of the same organization", async () => {
		await dismiss({ projectId: "project-a" });

		const onAnotherProject = await readDismissal("project-b");
		expect(onAnotherProject?.dismissedAt).toBeInstanceOf(Date);
	});

	it("declining on a second project of the same organization adds no row", async () => {
		await dismiss({ projectId: "project-a" });
		await dismiss({ projectId: "project-b" });

		expect(rows.size).toBe(1);
		expect(
			mockDb.cliConnectionPromptDismissal.upsert.mock.calls[1][0].where,
		).toEqual({
			organizationId_userId: { organizationId: ORG, userId: USER },
		});
	});

	it("leaves the same person's state in another organization untouched", async () => {
		await dismiss({ projectId: "project-a" });

		expect(await readDismissal("project-elsewhere")).toBeNull();

		await dismiss({ projectId: "project-elsewhere" });

		expect(rows.size).toBe(2);
		expect((await readDismissal("project-elsewhere"))?.organizationId).toBe(
			OTHER_ORG,
		);
	});

	it("leaves another member of the same organization undismissed", async () => {
		await dismiss({ projectId: "project-a" }, USER);

		expect(await readDismissal("project-a", "user-2")).toBeNull();
		expect(rows.size).toBe(1);
	});

	it("does not resolve its organization from caller input", async () => {
		await dismiss({
			projectId: "project-a",
			// A project this caller may read, paired with an organization they
			// may not. The write must ignore it.
			organizationId: OTHER_ORG,
		});

		expect(
			mockDb.cliConnectionPromptDismissal.upsert.mock.calls[0][0].where,
		).toEqual({
			organizationId_userId: { organizationId: ORG, userId: USER },
		});
		expect(
			rows.has(rowKey({ organizationId: OTHER_ORG, userId: USER })),
		).toBe(false);
	});

	it("refuses, and writes nothing, when readiness is disabled", async () => {
		mockIsFeatureEnabled.mockResolvedValue(false);

		await expect(dismiss({ projectId: "project-a" })).rejects.toMatchObject(
			{
				code: "NOT_FOUND",
			},
		);

		expect(mockIsFeatureEnabled).toHaveBeenCalledWith("PROJECT_READINESS");
		expect(
			mockDb.cliConnectionPromptDismissal.upsert,
		).not.toHaveBeenCalled();
		// The gate is checked before the project is even looked up.
		expect(mockGather).not.toHaveBeenCalled();
	});

	it("refuses when the project does not exist", async () => {
		await expect(dismiss({ projectId: "nope" })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(
			mockDb.cliConnectionPromptDismissal.upsert,
		).not.toHaveBeenCalled();
	});

	it("fails closed when the project has no organization", async () => {
		await expect(
			dismiss({ projectId: "project-tenantless" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(
			mockDb.cliConnectionPromptDismissal.upsert,
		).not.toHaveBeenCalled();
	});

	describe("the declared permission gate", () => {
		type TaggedMiddleware = ((
			options: { context: unknown; next: () => unknown },
			input: unknown,
		) => Promise<unknown>) & { [PERMISSION_MIDDLEWARE_TAG]?: string };

		/**
		 * The gate the procedure declares, pulled off its composed middleware
		 * chain and exercised for real. Asserting the tag alone would only say
		 * a permission was named; running it says it refuses.
		 */
		function permissionMiddleware(): TaggedMiddleware {
			const { middlewares } = (
				dismissCliNudgeProcedure as unknown as {
					"~orpc": { middlewares: TaggedMiddleware[] };
				}
			)["~orpc"];
			const found = middlewares.find(
				(mw) => mw[PERMISSION_MIDDLEWARE_TAG] !== undefined,
			);
			expect(found).toBeDefined();
			return found as TaggedMiddleware;
		}

		it("is project read", () => {
			expect(permissionMiddleware()[PERMISSION_MIDDLEWARE_TAG]).toBe(
				Permissions.PROJECT_READ,
			);
		});

		it("refuses a caller without project read access", async () => {
			mockResolveAccess.mockResolvedValue({
				permissions: [],
				source: "org",
				organizationId: ORG,
			});

			await expect(
				permissionMiddleware()(
					{ context: { user: { id: USER } }, next: () => ({}) },
					{ projectId: "project-a" },
				),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		});

		it("lets a caller with project read access through", async () => {
			const next = vi.fn(() => ({ passed: true }));

			await permissionMiddleware()(
				{ context: { user: { id: USER } }, next },
				{ projectId: "project-a" },
			);

			expect(next).toHaveBeenCalled();
		});
	});
});
