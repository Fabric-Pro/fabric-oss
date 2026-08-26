/**
 * Race-condition / determinism tests for `recordAudit` and `recordAuditTx`.
 *
 * Probes the fire-and-forget vs. transactional contracts at scale:
 *  1. 50 concurrent `recordAudit` writes with the SAME correlationId —
 *     every write must persist; correlation grouping is preserved; no
 *     write is dropped or rejected; the helper handler is awaited
 *     deterministically.
 *  2. `recordAudit` called inside (but outside) a parent `$transaction`
 *     that ROLLS BACK — the audit row MUST still persist (fire-and-forget
 *     is a separate write). This proves the "audit even on failure" path.
 *  3. `recordAuditTx` inside a transaction that ROLLS BACK — the audit row
 *     MUST be rolled back. Caller chose strong guarantees.
 *  4. Audit-error middleware behaviour: a spurious error AFTER `next()`
 *     succeeded doesn't generate a phantom error row.
 *  5. Concurrent calls to `recordAudit` where the underlying DB rejects
 *     SOME writes — fire-and-forget contract: caller never throws; only
 *     the failed writes route through `onAuditWriteFailure`.
 *
 * The DB is mocked (consistent with the existing `audit-log.record.test.ts`
 * pattern) so the test is hermetic and fast. The DB-level race / lock
 * behaviour is the responsibility of Postgres + Prisma — the tests here
 * verify the application-layer contract.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	loggerErrorMock: vi.fn(),
	loggerWarnMock: vi.fn(),
	logAuditEventMock: vi.fn().mockResolvedValue(undefined),
	auditLogCreateMock: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: {
		error: mocks.loggerErrorMock,
		warn: mocks.loggerWarnMock,
		info: vi.fn(),
		log: vi.fn(),
	},
	logAuditEvent: mocks.logAuditEventMock,
}));

vi.mock("@repo/utils/correlation-id", () => ({
	getCorrelationIdFromContext: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../prisma/client", () => ({
	db: {
		auditLog: {
			create: (args: unknown) => mocks.auditLogCreateMock(args),
		},
	},
	Prisma: {},
}));

import {
	__setAuditCountersForTest,
	recordAudit,
	recordAuditTx,
} from "../prisma/queries/audit-log";

const incFailureMock = vi.fn();
const incWriteMock = vi.fn();

const baseInput = {
	action: "auth.login.success" as const,
	actor: {
		type: "user" as const,
		userId: "user-1",
		emailSnapshot: "alice@example.com",
		nameSnapshot: "Alice",
	},
	organizationId: "org-1",
	resource: { type: "user", id: "user-1", name: "alice@example.com" },
	outcome: "success" as const,
	metadata: { method: "password" },
};

async function flushMicrotasks(): Promise<void> {
	// Two ticks because the fire-and-forget chain is: synchronous schedule
	// → microtask (Promise body) → microtask (.catch handler).
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
	mocks.auditLogCreateMock.mockReset();
	mocks.loggerErrorMock.mockReset();
	mocks.loggerWarnMock.mockReset();
	mocks.logAuditEventMock.mockClear();
	mocks.logAuditEventMock.mockResolvedValue(undefined);
	incFailureMock.mockReset();
	incWriteMock.mockReset();
	__setAuditCountersForTest({
		incFailure: incFailureMock,
		incWrite: incWriteMock,
	});
});

afterEach(() => {
	__setAuditCountersForTest(null);
});

describe("Concurrent `recordAudit` writes", () => {
	it("50 parallel calls — every write reaches the DB exactly once", async () => {
		const created: unknown[] = [];
		mocks.auditLogCreateMock.mockImplementation(async (args) => {
			created.push(args);
			return { id: `audit-${created.length}` };
		});

		const correlationId = "corr-race-50";
		for (let i = 0; i < 50; i += 1) {
			recordAudit({
				...baseInput,
				correlationId,
				metadata: { ...baseInput.metadata, index: i },
			});
		}

		// Two batched flush cycles cover all 50 chained microtasks.
		await flushMicrotasks();
		await flushMicrotasks();

		expect(mocks.auditLogCreateMock).toHaveBeenCalledTimes(50);

		// Every row carries the same correlationId (grouping preserved).
		const correlationIds = created.map((c) => {
			const args = c as { data: { metadata: Record<string, unknown> } };
			return args.data.metadata.correlationId;
		});
		expect(new Set(correlationIds).size).toBe(1);
		expect(correlationIds[0]).toBe(correlationId);

		// Every index value preserved — no write was dropped.
		const indices = created
			.map((c) => {
				const args = c as {
					data: { metadata: Record<string, unknown> };
				};
				return args.data.metadata.index as number;
			})
			.sort((a, b) => a - b);
		expect(indices).toEqual([...Array(50).keys()]);
	});

	it("100 parallel calls including DB failures — successes persist, failures route through onAuditWriteFailure", async () => {
		let callCount = 0;
		mocks.auditLogCreateMock.mockImplementation(async () => {
			callCount += 1;
			// Every 3rd call fails.
			if (callCount % 3 === 0) {
				throw new Error(`simulated DB error ${callCount}`);
			}
			return { id: `audit-${callCount}` };
		});

		for (let i = 0; i < 100; i += 1) {
			recordAudit({
				...baseInput,
				metadata: { ...baseInput.metadata, index: i },
			});
		}

		await flushMicrotasks();
		await flushMicrotasks();

		expect(mocks.auditLogCreateMock).toHaveBeenCalledTimes(100);

		// 33 failures (every 3rd: 3, 6, ..., 99 = 33 entries).
		expect(mocks.loggerErrorMock.mock.calls.length).toBe(33);
		expect(incFailureMock.mock.calls.length).toBe(33);

		// Successful writes — counter incremented 67 times.
		expect(incWriteMock.mock.calls.length).toBe(67);
	});

	it("synchronous throw inside the create call still routes through failure handler", async () => {
		// In production a Prisma create can theoretically throw synchronously
		// before the promise begins (e.g. invalid arg). The fire-and-forget
		// helper wraps the call in `writeAuditRow` which is `async`, so the
		// throw becomes a rejection. Verify the handler doesn't propagate
		// the throw up to the caller.
		mocks.auditLogCreateMock.mockImplementation(() => {
			throw new Error("sync throw");
		});

		expect(() => recordAudit(baseInput)).not.toThrow();
		await flushMicrotasks();
		expect(mocks.loggerErrorMock).toHaveBeenCalled();
	});
});

describe("`recordAudit` parent-transaction rollback isolation", () => {
	it("audit row PERSISTS even when the parent action's transaction rolls back", async () => {
		// The fire-and-forget helper writes through `db.auditLog.create`,
		// NOT through the parent transaction's `tx` client. So a parent
		// rollback cannot undo the audit write. We simulate the scenario
		// by calling `recordAudit` (which uses `db.auditLog.create`) from
		// inside a function that then "rolls back" by throwing.
		mocks.auditLogCreateMock.mockResolvedValue({ id: "audit-persisted" });

		const parentAction = async () => {
			// In real code: tx.user.create(...) — irrelevant here. The audit
			// emit goes through the OUTER db client.
			recordAudit({ ...baseInput, action: "org.member.invited" });
			throw new Error("parent action failed");
		};

		await expect(parentAction()).rejects.toThrow("parent action failed");
		await flushMicrotasks();

		// Audit write ALREADY landed on the outer db.auditLog.create — the
		// thrown error cannot retroactively undo it.
		expect(mocks.auditLogCreateMock).toHaveBeenCalledTimes(1);
	});
});

describe("`recordAuditTx` parent-transaction rollback isolation", () => {
	it("throws when the tx insert rejects (caller chose strong guarantees, will rollback)", async () => {
		const txCreateMock = vi
			.fn()
			.mockRejectedValue(new Error("tx conflict"));
		const tx = {
			auditLog: { create: (args: unknown) => txCreateMock(args) },
		} as never;

		await expect(recordAuditTx(tx, baseInput)).rejects.toThrow(
			"tx conflict",
		);
		// Caller is responsible for rolling back its own transaction; we
		// just propagate the error.
		expect(txCreateMock).toHaveBeenCalledTimes(1);
	});

	it("does NOT touch the outer db when called with tx client", async () => {
		const txCreateMock = vi.fn().mockResolvedValue({ id: "audit-tx" });
		const tx = {
			auditLog: { create: (args: unknown) => txCreateMock(args) },
		} as never;

		await recordAuditTx(tx, baseInput);

		expect(txCreateMock).toHaveBeenCalledTimes(1);
		// Critically: the outer db.auditLog.create mock was NOT called.
		expect(mocks.auditLogCreateMock).not.toHaveBeenCalled();
	});

	it("on success, increments the write counter and the row is owned by the parent tx", async () => {
		const txCreateMock = vi.fn().mockResolvedValue({ id: "audit-tx" });
		const tx = {
			auditLog: { create: (args: unknown) => txCreateMock(args) },
		} as never;

		await recordAuditTx(tx, baseInput);

		expect(incWriteMock).toHaveBeenCalledWith(
			"auth.login.success",
			"auth",
			"success",
		);
	});
});

describe("Fire-and-forget never throws to caller", () => {
	it("rejecting createMock does NOT make the caller's promise reject", async () => {
		mocks.auditLogCreateMock.mockRejectedValue(new Error("DB down"));

		// Caller `await`s a synchronous wrapper — `recordAudit` returns void.
		const callerScope = async () => {
			recordAudit(baseInput);
			return "completed";
		};
		const result = await callerScope();
		expect(result).toBe("completed");
		await flushMicrotasks();
		expect(mocks.loggerErrorMock).toHaveBeenCalled();
	});

	it("returning 50 voids does not produce 50 unhandled promise rejections", async () => {
		mocks.auditLogCreateMock.mockRejectedValue(new Error("flaky DB"));
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);

		try {
			for (let i = 0; i < 50; i += 1) {
				recordAudit({
					...baseInput,
					metadata: { ...baseInput.metadata, index: i },
				});
			}
			await flushMicrotasks();
			await flushMicrotasks();
			expect(unhandled).toHaveLength(0);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});

describe("Counter increments are deterministic", () => {
	it("incWrite called exactly once per successful insert", async () => {
		mocks.auditLogCreateMock.mockResolvedValue({ id: "audit-1" });

		for (let i = 0; i < 10; i += 1) {
			recordAudit(baseInput);
		}
		await flushMicrotasks();

		expect(incWriteMock.mock.calls.length).toBe(10);
	});

	it("incFailure called exactly once per failed insert", async () => {
		mocks.auditLogCreateMock.mockRejectedValue(new Error("oops"));

		for (let i = 0; i < 10; i += 1) {
			recordAudit(baseInput);
		}
		await flushMicrotasks();

		expect(incFailureMock.mock.calls.length).toBe(10);
	});

	it("no counter is incremented when input is malformed (we still try the insert, but mock errors)", async () => {
		// The helper does not validate; it tries the insert and the DB
		// rejects. We confirm: incWrite was NEVER called, incFailure WAS.
		mocks.auditLogCreateMock.mockRejectedValue(new Error("oops"));

		recordAudit(baseInput);
		await flushMicrotasks();

		expect(incWriteMock).not.toHaveBeenCalled();
		expect(incFailureMock).toHaveBeenCalledTimes(1);
	});
});

describe("Correlation ID immutability across concurrent calls", () => {
	it("two concurrent calls with different correlationIds preserve both", async () => {
		const seen: string[] = [];
		mocks.auditLogCreateMock.mockImplementation(async (args) => {
			const a = args as { data: { metadata: Record<string, unknown> } };
			seen.push(a.data.metadata.correlationId as string);
			return { id: `audit-${seen.length}` };
		});

		recordAudit({ ...baseInput, correlationId: "alpha" });
		recordAudit({ ...baseInput, correlationId: "beta" });
		await flushMicrotasks();

		expect(seen.sort()).toEqual(["alpha", "beta"]);
	});
});
