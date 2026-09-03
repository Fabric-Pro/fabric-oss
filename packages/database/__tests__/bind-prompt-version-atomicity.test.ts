/**
 * Binding a default is one change, and the unique key is real now.
 *
 * Two things this pins:
 *
 * 1. Demoting the previous default and writing the new one happen in one
 *    transaction. They used to be separate statements on the bare client, so a
 *    failure in between left the action with NO default — the old row stood
 *    down, the new one never written.
 *
 * 2. A concurrent bind is adopted rather than thrown. Until the accompanying
 *    migration, the composite unique key enforced nothing for any row the app
 *    writes (Postgres treats NULL as distinct, and every binding shape carries
 *    a NULL in that key), so two racing binds silently produced two rows. With
 *    `NULLS NOT DISTINCT` the loser now gets P2002, and the right answer is to
 *    take over the winner's row — the same end state either order produces —
 *    not to fail the user's click.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/bind-prompt-version-atomicity.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	findFirst,
	create,
	update,
	updateMany,
	transaction,
	FakeKnownRequestError,
} = vi.hoisted(() => ({
	findFirst: vi.fn(),
	create: vi.fn(),
	update: vi.fn(),
	updateMany: vi.fn(),
	transaction: vi.fn(),
	// Declared here because `vi.mock` is hoisted above the file body and its
	// factory reaches for this class.
	FakeKnownRequestError: class extends Error {
		code: string;
		constructor(code: string) {
			super(`fake prisma error ${code}`);
			this.code = code;
		}
	},
}));

vi.mock("../prisma/client", () => {
	const promptBinding = { findFirst, create, update, updateMany };
	return {
		db: {
			promptBinding,
			$transaction: (fn: (tx: unknown) => unknown) => {
				transaction(fn);
				return fn({ promptBinding });
			},
		},
		Prisma: { PrismaClientKnownRequestError: FakeKnownRequestError },
	};
});

import { bindPromptVersion } from "../prisma/queries/prompts";

const TARGET = {
	targetType: "AGENT" as const,
	targetKey: "test_case_drafter",
	documentType: "GENERAL",
	scope: "ORG" as const,
	organizationId: "org-1",
	promptVersionId: "ver-new",
};

beforeEach(() => {
	for (const m of [findFirst, create, update, updateMany, transaction]) {
		m.mockReset();
	}
	findFirst.mockResolvedValue(null);
	create.mockResolvedValue({ id: "created" });
	update.mockResolvedValue({ id: "updated" });
	updateMany.mockResolvedValue({ count: 0 });
});

describe("the demote and the write land together", () => {
	it("opens a transaction when the caller has none", async () => {
		await bindPromptVersion({ ...TARGET, isDefault: true });

		expect(transaction).toHaveBeenCalledTimes(1);
	});

	it("keeps the caller's own transaction when given one", async () => {
		await bindPromptVersion({
			...TARGET,
			isDefault: true,
			client: {
				promptBinding: { findFirst, create, update, updateMany },
			} as never,
		});

		// A multi-action bind owns the transaction; opening a second one here
		// would split that batch into separately-committed writes.
		expect(transaction).not.toHaveBeenCalled();
		expect(create).toHaveBeenCalledTimes(1);
	});
});

describe("losing the insert race", () => {
	it("adopts the winner's row instead of failing the bind", async () => {
		create.mockRejectedValueOnce(new FakeKnownRequestError("P2002"));
		// The row the winning caller committed while this one was writing.
		findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
			id: "winner-row",
		});

		const result = await bindPromptVersion({ ...TARGET, isDefault: true });

		expect(update).toHaveBeenCalledWith({
			where: { id: "winner-row" },
			data: { promptVersionId: "ver-new", isDefault: true },
		});
		expect(result).toEqual({ id: "updated" });
	});

	it("rethrows anything that is not a uniqueness collision", async () => {
		create.mockRejectedValueOnce(new FakeKnownRequestError("P2003"));

		await expect(
			bindPromptVersion({ ...TARGET, isDefault: true }),
		).rejects.toMatchObject({ code: "P2003" });
	});
});
