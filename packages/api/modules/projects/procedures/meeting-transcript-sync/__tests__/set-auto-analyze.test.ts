/**
 * Unit tests for `setAutoAnalyzeProcedure`.
 *
 * Covered surfaces:
 *   - Auth: the procedure declares `requireProjectPermission(PROJECT_UPDATE)`.
 *   - Tenant scope (matches sibling `enable-meeting-transcript-sync`): org ⇒
 *     { organizationId } (org-owned — editable by any PROJECT_UPDATE member, not
 *     just the creator); personal ⇒ { organizationId: null, userId } — applied to
 *     BOTH the existence `findFirst` and the persisting `update`.
 *   - Persistence: `meetingTranscriptAutoAnalyzeEnabled` is written for both
 *     `enabled: true` and `enabled: false`.
 *   - NOT_FOUND when the tenant-scoped project lookup misses (no update).
 *   - No Temporal workflow is started (flag-only procedure).
 *
 * Handler-capture + mocked-builder pattern mirrors
 * `backlog/__tests__/dismiss-failed-proposal.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		projectFindFirst: vi.fn(),
		projectUpdate: vi.fn(),
		requireProjectPermission: vi.fn(() => (c: unknown) => c),
	};
	return { handlers, mocks };
});

// Partial mock: keep every real export (so the transitive
// `@repo/payments` → `setAiUsageRecorder(...)` top-level side effect still
// resolves) and override only `db`.
vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		db: {
			project: {
				findFirst: (...args: unknown[]) =>
					mocks.projectFindFirst(...args),
				update: (...args: unknown[]) => mocks.projectUpdate(...args),
			},
		},
	};
});

vi.mock("../../../../../orpc/procedures", () => {
	const importedHandlerKeys = ["setAutoAnalyze"];
	let cursor = 0;
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			const key = importedHandlerKeys[cursor++] ?? `proc-${cursor}`;
			handlers[key] = fn;
			return { _handler: fn };
		},
	});

	return {
		tenantProtectedProcedure: chainable,
		Permissions: { PROJECT_UPDATE: "project:update" },
		requireProjectPermission: (...args: unknown[]) =>
			mocks.requireProjectPermission(...args),
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? undefined,
	};
});

await import("../set-auto-analyze");

const ctx = { user: { id: "user-1" }, session: {} };

beforeEach(() => {
	mocks.projectFindFirst.mockReset();
	mocks.projectUpdate.mockReset();
	mocks.projectUpdate.mockResolvedValue({ id: "project-1" });
});

describe("setAutoAnalyzeProcedure — auth", () => {
	it("requires PROJECT_UPDATE permission", () => {
		expect(mocks.requireProjectPermission).toHaveBeenCalledWith(
			"project:update",
		);
	});
});

describe("setAutoAnalyzeProcedure — org context", () => {
	it("uses the { organizationId } filter (org-owned) and persists enabled=true", async () => {
		mocks.projectFindFirst.mockResolvedValue({ id: "project-1" });

		const result = (await handlers.setAutoAnalyze({
			input: {
				projectId: "project-1",
				organizationId: "org-1",
				enabled: true,
			},
			context: ctx,
		})) as { status: string; meetingTranscriptAutoAnalyzeEnabled: boolean };

		expect(result.meetingTranscriptAutoAnalyzeEnabled).toBe(true);

		expect(mocks.projectFindFirst).toHaveBeenCalledWith({
			where: { id: "project-1", organizationId: "org-1" },
			select: { id: true },
		});
		expect(mocks.projectUpdate).toHaveBeenCalledWith({
			where: { id: "project-1", organizationId: "org-1" },
			data: { meetingTranscriptAutoAnalyzeEnabled: true },
		});
	});
});

describe("setAutoAnalyzeProcedure — personal context", () => {
	it("uses the { organizationId: null, userId } XOR filter and persists enabled=false", async () => {
		mocks.projectFindFirst.mockResolvedValue({ id: "project-1" });

		const result = (await handlers.setAutoAnalyze({
			input: { projectId: "project-1", enabled: false },
			context: ctx,
		})) as { status: string; meetingTranscriptAutoAnalyzeEnabled: boolean };

		expect(result.meetingTranscriptAutoAnalyzeEnabled).toBe(false);

		expect(mocks.projectFindFirst).toHaveBeenCalledWith({
			where: { id: "project-1", organizationId: null, userId: "user-1" },
			select: { id: true },
		});
		expect(mocks.projectUpdate).toHaveBeenCalledWith({
			where: { id: "project-1", organizationId: null, userId: "user-1" },
			data: { meetingTranscriptAutoAnalyzeEnabled: false },
		});
	});
});

describe("setAutoAnalyzeProcedure — guard", () => {
	it("throws NOT_FOUND and does not update when the project lookup misses", async () => {
		mocks.projectFindFirst.mockResolvedValue(null);

		await expect(
			handlers.setAutoAnalyze({
				input: {
					projectId: "missing",
					organizationId: "org-1",
					enabled: true,
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(mocks.projectUpdate).not.toHaveBeenCalled();
	});
});
