/**
 * Tests for the `userActivity.viewed` audit-emit added to
 * `userActivity.listMembers` and `userActivity.memberHistory`.
 *
 * Mirrors the pattern in `packages/api/modules/audit/__tests__/list.test.ts`
 * — call the handler directly via `procedure["~orpc"].handler` to bypass
 * the middleware pipeline (auth-gate coverage lives in
 * `require-audit-log-read.test.ts`), and assert against the mocked
 * `recordAudit` (the `@repo/database` fire-and-forget primitive that
 * `recordAuditFromRequest` wraps).
 *
 * Spec: docs/audit-log/README.md §6.1 (D12).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listMemberActivity: vi.fn(),
	getMemberLoginHistory: vi.fn(),
	recordAudit: vi.fn(),
	getTrustedClientIp: vi.fn().mockReturnValue("127.0.0.1"),
}));

// `importActual` lets the procedures' transitive dependencies (e.g.
// `@repo/ai` reading `DB_GATEWAY_PROVIDERS`) keep working. We only
// override the symbols we drive directly.
vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		listMemberActivity: mocks.listMemberActivity,
		getMemberLoginHistory: mocks.getMemberLoginHistory,
		recordAudit: mocks.recordAudit,
	};
});

vi.mock("@repo/auth/lib/client-ip", () => ({
	getTrustedClientIp: mocks.getTrustedClientIp,
}));

vi.mock("@repo/observability", () => ({
	auditWriteFailures: { inc: vi.fn() },
	auditWritesTotal: { inc: vi.fn() },
}));

// `protectedProcedure` imports lazily from `@repo/payments` only on the
// catch path of the AI-usage-limit error mapper, but the procedures
// module re-exports its types eagerly. Stub the whole package so module
// load doesn't blow up.
vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class {},
}));

import { listMemberActivityProcedure } from "../list-members";
import { getMemberLoginHistoryProcedure } from "../member-history";

function makeContext() {
	return {
		user: {
			id: "user-1",
			email: "alice@example.com",
			name: "Alice",
		},
		session: { id: "session-1" },
		headers: new Headers(),
	};
}

function getHandler<TInput extends Record<string, unknown>, TResult>(
	procedure: unknown,
) {
	return (
		procedure as unknown as {
			"~orpc": {
				handler: (args: {
					context: ReturnType<typeof makeContext>;
					input: TInput;
				}) => Promise<TResult>;
			};
		}
	)["~orpc"].handler;
}

const listMembersHandler = getHandler<
	Record<string, unknown>,
	{ items: unknown[]; total: number }
>(listMemberActivityProcedure);

const memberHistoryHandler = getHandler<Record<string, unknown>, unknown>(
	getMemberLoginHistoryProcedure,
);

beforeEach(() => {
	mocks.listMemberActivity.mockReset();
	mocks.getMemberLoginHistory.mockReset();
	mocks.recordAudit.mockReset();
	vi.stubEnv("FABRIC_FEATURE_USER_ACTIVITY_DASHBOARD", "");
});

describe("userActivity.listMembers audit emit", () => {
	it("emits one `userActivity.viewed` event per successful call", async () => {
		mocks.listMemberActivity.mockResolvedValue({
			items: [{ userId: "u-1" }, { userId: "u-2" }],
			total: 2,
		});

		await listMembersHandler({
			context: makeContext(),
			input: {
				organizationId: "org-1",
				rangeDays: 30,
				sortDir: "desc",
				query: "",
				limit: 25,
				offset: 0,
			},
		});

		expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
		const audit = mocks.recordAudit.mock.calls[0]?.[0] as {
			action: string;
			category: string;
			organizationId: string;
			outcome: string;
			metadata: { endpoint: string; resultCount: number };
		};
		expect(audit.action).toBe("userActivity.viewed");
		expect(audit.category).toBe("audit");
		expect(audit.organizationId).toBe("org-1");
		expect(audit.outcome).toBe("success");
		expect(audit.metadata.endpoint).toBe("listMembers");
		expect(audit.metadata.resultCount).toBe(2);
	});

	it("does not emit when the feature flag is off", async () => {
		vi.stubEnv("FABRIC_FEATURE_USER_ACTIVITY_DASHBOARD", "off");

		await expect(
			listMembersHandler({
				context: makeContext(),
				input: {
					organizationId: "org-1",
					rangeDays: 30,
					sortDir: "desc",
					query: "",
					limit: 25,
					offset: 0,
				},
			}),
		).rejects.toThrow();

		expect(mocks.listMemberActivity).not.toHaveBeenCalled();
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("never fails the read when the audit write throws", async () => {
		mocks.listMemberActivity.mockResolvedValue({ items: [], total: 0 });
		mocks.recordAudit.mockImplementation(() => {
			throw new Error("db unavailable");
		});

		const result = await listMembersHandler({
			context: makeContext(),
			input: {
				organizationId: "org-1",
				rangeDays: 30,
				sortDir: "desc",
				query: "",
				limit: 25,
				offset: 0,
			},
		});

		expect(result.total).toBe(0);
	});
});

describe("userActivity.memberHistory audit emit", () => {
	function makeHistory() {
		return {
			user: {
				id: "u-2",
				name: "Bob",
				email: "bob@example.com",
				image: null,
			},
			role: "member",
			buckets: [],
			totalLoginsInRange: 3,
			recentEvents: [],
		};
	}

	it("emits one `userActivity.viewed` event with the target userId in metadata", async () => {
		mocks.getMemberLoginHistory.mockResolvedValue(makeHistory());

		await memberHistoryHandler({
			context: makeContext(),
			input: {
				organizationId: "org-1",
				userId: "u-2",
				rangeDays: 30,
			},
		});

		expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
		const audit = mocks.recordAudit.mock.calls[0]?.[0] as {
			action: string;
			category: string;
			organizationId: string;
			metadata: { endpoint: string; targetUserId: string };
		};
		expect(audit.action).toBe("userActivity.viewed");
		expect(audit.category).toBe("audit");
		expect(audit.organizationId).toBe("org-1");
		expect(audit.metadata.endpoint).toBe("memberHistory");
		expect(audit.metadata.targetUserId).toBe("u-2");
	});

	it("does not emit when the target user is not a member (NOT_FOUND)", async () => {
		mocks.getMemberLoginHistory.mockResolvedValue(null);

		await expect(
			memberHistoryHandler({
				context: makeContext(),
				input: {
					organizationId: "org-1",
					userId: "u-3",
					rangeDays: 30,
				},
			}),
		).rejects.toThrow();

		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("does not emit when the feature flag is off", async () => {
		vi.stubEnv("FABRIC_FEATURE_USER_ACTIVITY_DASHBOARD", "off");

		await expect(
			memberHistoryHandler({
				context: makeContext(),
				input: {
					organizationId: "org-1",
					userId: "u-2",
					rangeDays: 30,
				},
			}),
		).rejects.toThrow();

		expect(mocks.getMemberLoginHistory).not.toHaveBeenCalled();
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});
});
