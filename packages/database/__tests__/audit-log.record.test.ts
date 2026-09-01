/**
 * Unit tests for `recordAudit` and `recordAuditTx`.
 *
 * Covers the cases enumerated in spec.md §13.1 -- happy path (snapshot
 * fields populated), DB-error path (fire-and-forget does not throw,
 * fallback to stdout logger via @repo/logs, counter increments),
 * category derivation, metadata redaction.
 *
 * Run with: pnpm --filter @repo/database test __tests__/audit-log.record.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock @repo/logs FIRST so the audit-log module captures these
// references at import time. logAuditEvent must return a resolved
// promise so the fire-and-forget fallback completes without
// dangling-promise warnings.
//
// NOTE: vi.mock is hoisted to the top of the file by vitest, BEFORE
// any other module-scope code. That hoist also moves it ABOVE local
// variable declarations, so we must use vi.hoisted to create shared
// mock fns the factory can close over.
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
	// Default fallback when not running inside `runWithCorrelationId`. Tests
	// that need a value re-import the real implementation via
	// `await vi.importActual` or call this through ALS.
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

// Import AFTER the mocks so the module captures them.
import {
	__setAuditCountersForTest,
	AUDIT_ACTIONS,
	mapToLegacyEventType,
	onAuditWriteFailure,
	recordAudit,
	recordAuditTx,
} from "../prisma/queries/audit-log";

const incFailureMock = vi.fn();
const incWriteMock = vi.fn();

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

async function flush(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
}

describe("recordAudit (fire-and-forget)", () => {
	it("inserts a row with snapshot fields populated", async () => {
		mocks.auditLogCreateMock.mockResolvedValue({ id: "audit-1" });

		recordAudit(baseInput);
		await flush();

		expect(mocks.auditLogCreateMock).toHaveBeenCalledTimes(1);
		const args = mocks.auditLogCreateMock.mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		expect(args.data.actorEmailSnapshot).toBe("alice@example.com");
		expect(args.data.actorNameSnapshot).toBe("Alice");
		expect(args.data.resourceName).toBe("alice@example.com");
		expect(args.data.action).toBe("auth.login.success");
	});

	it("derives category from action prefix when not supplied", async () => {
		mocks.auditLogCreateMock.mockResolvedValue({ id: "audit-1" });
		recordAudit(baseInput);
		await flush();

		const args = mocks.auditLogCreateMock.mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		expect(args.data.category).toBe("auth");
	});

	it("redacts metadata before insert", async () => {
		mocks.auditLogCreateMock.mockResolvedValue({ id: "audit-1" });
		recordAudit({
			...baseInput,
			metadata: { password: "secret", note: "hello" },
		});
		await flush();

		const args = mocks.auditLogCreateMock.mock.calls[0]?.[0] as {
			data: { metadata: Record<string, unknown> };
		};
		expect(args.data.metadata).toEqual({
			password: "[REDACTED]",
			note: "hello",
		});
	});

	it("returns void synchronously even when the insert rejects", () => {
		mocks.auditLogCreateMock.mockRejectedValue(new Error("DB down"));
		expect(() => recordAudit(baseInput)).not.toThrow();
	});

	it("does NOT throw and routes through the failure handler when DB rejects", async () => {
		const dbError = new Error("DB down");
		mocks.auditLogCreateMock.mockRejectedValue(dbError);

		recordAudit(baseInput);
		await flush();

		expect(mocks.loggerErrorMock).toHaveBeenCalledTimes(1);
		const firstCallArgs = mocks.loggerErrorMock.mock.calls[0] ?? [];
		const logPayload = firstCallArgs[0] as Record<string, unknown>;
		expect(logPayload).toMatchObject({
			event: "audit.write_failed",
			action: "auth.login.success",
			category: "auth",
		});

		expect(incFailureMock).toHaveBeenCalledWith(
			"auth.login.success",
			"auth",
		);

		expect(mocks.logAuditEventMock).toHaveBeenCalledTimes(1);
		const fallbackCall = mocks.logAuditEventMock.mock.calls[0] ?? [];
		expect(fallbackCall[0]).toBe("AUTH_LOGIN_SUCCESS");
	});

	it("increments the success counter on a successful insert", async () => {
		mocks.auditLogCreateMock.mockResolvedValue({ id: "audit-1" });
		recordAudit(baseInput);
		await flush();

		expect(incWriteMock).toHaveBeenCalledWith(
			"auth.login.success",
			"auth",
			"success",
		);
	});
});

describe("recordAuditTx (transactional)", () => {
	it("inserts via the transaction client and awaits it", async () => {
		const txCreateMock = vi.fn().mockResolvedValue({ id: "audit-tx" });
		const tx = {
			auditLog: { create: (args: unknown) => txCreateMock(args) },
		} as never;

		await recordAuditTx(tx, baseInput);

		expect(txCreateMock).toHaveBeenCalledTimes(1);
		expect(mocks.auditLogCreateMock).not.toHaveBeenCalled();
	});

	it("throws when the transaction insert rejects (caller chose strong guarantees)", async () => {
		const txCreateMock = vi.fn().mockRejectedValue(new Error("conflict"));
		const tx = {
			auditLog: { create: (args: unknown) => txCreateMock(args) },
		} as never;

		await expect(recordAuditTx(tx, baseInput)).rejects.toThrow("conflict");
	});
});

describe("onAuditWriteFailure", () => {
	it("emits a structured error log, increments counter, and falls back to stdout", () => {
		onAuditWriteFailure(
			{
				...baseInput,
				action: "org.member.invited",
			},
			new Error("db is on fire"),
		);

		expect(mocks.loggerErrorMock).toHaveBeenCalledTimes(1);
		expect(incFailureMock).toHaveBeenCalledWith(
			"org.member.invited",
			"org",
		);
		expect(mocks.logAuditEventMock).toHaveBeenCalledTimes(1);
	});
});

describe("mapToLegacyEventType", () => {
	it("maps known auth actions to AUTH_* events", () => {
		expect(mapToLegacyEventType("auth.login.success")).toBe(
			"AUTH_LOGIN_SUCCESS",
		);
		expect(mapToLegacyEventType("auth.mfa.enabled")).toBe(
			"AUTH_MFA_ENABLED",
		);
	});

	it("maps audit.viewed to DATA_READ and audit.exported to DATA_EXPORT", () => {
		expect(mapToLegacyEventType("audit.viewed")).toBe("DATA_READ");
		expect(mapToLegacyEventType("audit.exported")).toBe("DATA_EXPORT");
	});

	it("falls back to DATA_CREATE for unknown actions", () => {
		expect(mapToLegacyEventType("something.unknown.happened")).toBe(
			"DATA_CREATE",
		);
	});
});

describe("unknown-action warning", () => {
	it("logs a structured warning when action is outside the closed taxonomy", async () => {
		mocks.auditLogCreateMock.mockResolvedValue({ id: "audit-1" });
		recordAudit({
			...baseInput,
			action: "made.up.action",
		});
		await flush();

		expect(mocks.loggerWarnMock).toHaveBeenCalledTimes(1);
		const warnArgs = mocks.loggerWarnMock.mock.calls[0] ?? [];
		expect(warnArgs[0]).toMatchObject({
			event: "audit.unknown_action",
			action: "made.up.action",
		});
	});
});

describe("correlationId in metadata (D16)", () => {
	it("folds an explicit correlationId into metadata", async () => {
		mocks.auditLogCreateMock.mockResolvedValue({ id: "audit-1" });
		recordAudit({
			...baseInput,
			correlationId: "corr-explicit-123",
		});
		await flush();

		const args = mocks.auditLogCreateMock.mock.calls[0]?.[0] as {
			data: { metadata: Record<string, unknown> };
		};
		expect(args.data.metadata.correlationId).toBe("corr-explicit-123");
		// existing fields preserved
		expect(args.data.metadata.method).toBe("password");
	});

	it("merges correlationId without losing other metadata", async () => {
		mocks.auditLogCreateMock.mockResolvedValue({ id: "audit-1" });
		recordAudit({
			...baseInput,
			metadata: { a: 1, b: "two" },
			correlationId: "c-id",
		});
		await flush();

		const args = mocks.auditLogCreateMock.mock.calls[0]?.[0] as {
			data: { metadata: Record<string, unknown> };
		};
		expect(args.data.metadata).toMatchObject({
			a: 1,
			b: "two",
			correlationId: "c-id",
		});
	});

	it("does NOT redact correlationId (non-secret tracing data)", async () => {
		mocks.auditLogCreateMock.mockResolvedValue({ id: "audit-1" });
		recordAudit({
			...baseInput,
			correlationId: "corr-not-secret",
		});
		await flush();

		const args = mocks.auditLogCreateMock.mock.calls[0]?.[0] as {
			data: { metadata: Record<string, unknown> };
		};
		expect(args.data.metadata.correlationId).toBe("corr-not-secret");
	});

	it("omits metadata entirely when neither correlationId nor metadata is provided", async () => {
		mocks.auditLogCreateMock.mockResolvedValue({ id: "audit-1" });
		const { metadata: _drop, ...inputWithoutMetadata } = baseInput;
		void _drop;
		recordAudit(inputWithoutMetadata);
		await flush();

		const args = mocks.auditLogCreateMock.mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		expect(args.data.metadata).toBeUndefined();
	});
});

describe("incident audit actions (D17)", () => {
	it("accepts the closed incident.* keys without unknown-action warning", async () => {
		mocks.auditLogCreateMock.mockResolvedValue({ id: "audit-1" });
		recordAudit({
			...baseInput,
			action: "incident.fired",
			category: "incident",
			actor: { type: "system" },
			organizationId: null,
		});
		await flush();

		// No warning fired — incident.fired is in the closed taxonomy.
		expect(mocks.loggerWarnMock).not.toHaveBeenCalled();
		const args = mocks.auditLogCreateMock.mock.calls[0]?.[0] as {
			data: { action: string; category: string };
		};
		expect(args.data.action).toBe("incident.fired");
		expect(args.data.category).toBe("incident");
	});

	it("derives 'incident' category from incident.acknowledged when omitted", async () => {
		mocks.auditLogCreateMock.mockResolvedValue({ id: "audit-1" });
		// baseInput does not set `category`; the helper should derive it.
		recordAudit({
			...baseInput,
			action: "incident.acknowledged",
			actor: { type: "user", userId: "u-1" },
		});
		await flush();

		const args = mocks.auditLogCreateMock.mock.calls[0]?.[0] as {
			data: { category: string };
		};
		expect(args.data.category).toBe("incident");
	});
});

describe("audit taxonomy — closed action set", () => {
	it("includes story.auto_unhidden in AUDIT_ACTIONS", () => {
		expect(AUDIT_ACTIONS).toContain("story.auto_unhidden");
	});

	it("includes story.pm_ticket_unlinked in the closed taxonomy", () => {
		expect(AUDIT_ACTIONS).toContain("story.pm_ticket_unlinked");
	});

	it("includes project.ci_run.triggered in the closed taxonomy", () => {
		// Starting a run in a customer's CI spends a stored customer credential
		// on their own infrastructure, so it is exactly the kind of event a
		// CC6/CC7 review filters for by action. An unregistered action still
		// writes its row, but only after `buildAuditRow` logs
		// `audit.unknown_action` — so the ledger works while the taxonomy quietly
		// says otherwise.
		expect(AUDIT_ACTIONS).toContain("project.ci_run.triggered");
	});

	it("includes the project Databricks knowledge binding lifecycle in the closed taxonomy", () => {
		// Connecting a binding points every agent/retrieval flow in the
		// project at an external customer corpus via a stored org credential.
		expect(AUDIT_ACTIONS).toContain(
			"project.databricks_knowledge.connected",
		);
		expect(AUDIT_ACTIONS).toContain(
			"project.databricks_knowledge.disconnected",
		);
	});

	// Fizzy #2210. The primary generation failure is recorded here rather than on
	// the document, because the document's error field renders verbatim to every
	// project member. An action missing from this closed list is written as
	// `audit.unknown_action` and drops out of the admin viewer's action filter —
	// the same way `project.pull_request.comment_posted` once did — so being IN
	// the taxonomy is what makes the row retrievable, not merely durable.
	it("includes project.document_generation.failed in AUDIT_ACTIONS", () => {
		expect(AUDIT_ACTIONS).toContain("project.document_generation.failed");
	});
});
