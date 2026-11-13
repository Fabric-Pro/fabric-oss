import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	raw: vi.fn(),
	turn: vi.fn(),
	existing: vi.fn(),
	usage: vi.fn(),
	create: vi.fn(),
	update: vi.fn(),
	transaction: vi.fn(),
}));
vi.mock("../prisma/client", () => ({
	db: { $transaction: mocks.transaction },
}));

import { advisorToolResultStorage } from "../prisma/queries/advisor-tool-results";

const input = {
	attempt: 1,
	userId: "example-user",
	organizationId: "example-org",
	conversationId: "example-conversation",
	turnId: "example-turn",
	sourceKey: "example-execution:0",
	toolName: "code_tree",
	text: "example text",
};
describe("Advisor storage transaction fences", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.raw.mockResolvedValue([{ id: input.conversationId }]);
		mocks.turn.mockResolvedValue({ id: input.turnId });
		mocks.existing.mockResolvedValue(null);
		mocks.usage.mockResolvedValue({ _sum: { sizeBytes: 0 } });
		mocks.create.mockResolvedValue({});
		mocks.transaction.mockImplementation((fn) =>
			fn({
				$queryRaw: mocks.raw,
				conversationTurn: { findFirst: mocks.turn },
				advisorToolResult: {
					findUnique: mocks.existing,
					aggregate: mocks.usage,
					create: mocks.create,
					update: mocks.update,
				},
			}),
		);
	});
	it("places each ownership predicate immediately before the locked write", async () => {
		await advisorToolResultStorage.write(input);
		const [sql, ...values] = mocks.raw.mock.calls[1];
		const query = sql.join("?");
		expect(query).toContain('"id"=?');
		expect(query).toContain('"userId"=?');
		expect(query).toContain('"organizationId"=?');
		expect(query).toContain("FOR UPDATE");
		expect(values).toEqual([
			input.conversationId,
			input.userId,
			input.organizationId,
		]);
		expect(mocks.turn).toHaveBeenCalledWith({
			where: {
				id: input.turnId,
				conversationId: input.conversationId,
				userId: input.userId,
				organizationId: input.organizationId,
			},
			select: { id: true },
		});
	});
	it("configures one bounded attempt with pool, transaction, statement and lock ceilings", async () => {
		await advisorToolResultStorage.write(input);
		expect(mocks.transaction.mock.calls[0][1]).toEqual({
			maxWait: 250,
			timeout: 1000,
		});
		expect(mocks.raw.mock.calls[0][0].join("")).toContain(
			"set_config('statement_timeout', '200ms', true)",
		);
		expect(mocks.raw.mock.calls[0][0].join("")).toContain(
			"set_config('lock_timeout', '100ms', true)",
		);
	});
	it("refuses a missing conversation even if a lower layer could match a turn", async () => {
		mocks.raw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
		expect(await advisorToolResultStorage.write(input)).toBe(
			"scope_mismatch",
		);
		expect(mocks.create).not.toHaveBeenCalled();
	});
	it("refuses a missing turn even if a lower layer could create a row", async () => {
		mocks.turn.mockResolvedValue(null);
		expect(await advisorToolResultStorage.write(input)).toBe(
			"scope_mismatch",
		);
		expect(mocks.create).not.toHaveBeenCalled();
	});
	it("counts only unexpired content for this conversation", async () => {
		await advisorToolResultStorage.write(input);
		expect(mocks.usage).toHaveBeenCalledWith({
			where: {
				conversationId: input.conversationId,
				expiresAt: { gt: expect.any(Date) },
			},
			_sum: { sizeBytes: true },
		});
	});
	it("replaces the row for a higher activity attempt", async () => {
		mocks.existing.mockResolvedValue({
			id: "example-row",
			attempt: 1,
			sizeBytes: 4,
			expiresAt: new Date(Date.now() + 60_000),
		});
		expect(
			await advisorToolResultStorage.write({ ...input, attempt: 2 }),
		).toBe("stored");
		expect(mocks.update).toHaveBeenCalledWith({
			where: { id: "example-row" },
			data: expect.objectContaining({
				attempt: 2,
				content: { v: 1, text: input.text },
				sizeBytes: 12,
				expiresAt: expect.any(Date),
			}),
		});
		expect(mocks.create).not.toHaveBeenCalled();
	});
	it.each([1, 2])(
		"leaves an equal or higher persisted attempt unchanged for incoming %s",
		async (attempt) => {
			mocks.existing.mockResolvedValue({
				id: "example-row",
				attempt: 2,
				sizeBytes: 4,
				expiresAt: new Date(Date.now() + 60_000),
			});
			expect(
				await advisorToolResultStorage.write({ ...input, attempt }),
			).toBe("duplicate");
			expect(mocks.update).not.toHaveBeenCalled();
			expect(mocks.create).not.toHaveBeenCalled();
		},
	);
	it("subtracts the unexpired replaced content from the cap", async () => {
		mocks.existing.mockResolvedValue({
			id: "example-row",
			attempt: 1,
			sizeBytes: 1024 * 1024,
			expiresAt: new Date(Date.now() + 60_000),
		});
		mocks.usage.mockResolvedValue({
			_sum: { sizeBytes: 16 * 1024 * 1024 },
		});
		expect(
			await advisorToolResultStorage.write({ ...input, attempt: 2 }),
		).toBe("stored");
	});
	it("does not subtract expired content that was absent from cap usage", async () => {
		mocks.existing.mockResolvedValue({
			id: "example-row",
			attempt: 1,
			sizeBytes: 1024 * 1024,
			expiresAt: new Date(0),
		});
		mocks.usage.mockResolvedValue({
			_sum: { sizeBytes: 16 * 1024 * 1024 },
		});
		expect(
			await advisorToolResultStorage.write({ ...input, attempt: 2 }),
		).toBe("conversation_limit");
		expect(mocks.update).not.toHaveBeenCalled();
	});
});
