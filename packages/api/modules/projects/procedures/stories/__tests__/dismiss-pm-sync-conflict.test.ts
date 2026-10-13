/**
 * Dismissing a PM-sync conflict re-arms auto-push only while the row is still
 * CONFLICT: a sync enqueued since the dialog opened has stamped PENDING, and
 * the dismiss must not overwrite it with SUCCESS (which would also hide that
 * sync from the stuck-sync watchdog).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string };

const h = vi.hoisted(() => ({
	handler: undefined as
		| undefined
		| ((args: { input: Record<string, unknown> }) => Promise<unknown>),
	row: { id: "" } as Record<string, unknown> & { id: string },
}));

function matches(row: Row, where: Record<string, unknown>): boolean {
	return Object.entries(where).every(
		([key, value]) => (row[key] ?? null) === value,
	);
}

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<object>()),
	db: {
		userStory: {
			findFirst: vi.fn(async ({ where }: { where: Row }) =>
				matches(h.row, where) ? { id: h.row.id } : null,
			),
			update: vi.fn(
				async ({ data }: { data: Record<string, unknown> }) => {
					Object.assign(h.row, data);
					return h.row;
				},
			),
			updateMany: vi.fn(
				async ({
					where,
					data,
				}: {
					where: Record<string, unknown>;
					data: Record<string, unknown>;
				}) => {
					if (!matches(h.row, where)) {
						return { count: 0 };
					}
					Object.assign(h.row, data);
					return { count: 1 };
				},
			),
		},
	},
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: typeof h.handler) => {
			h.handler = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
	};
});

await import("../dismiss-pm-sync-conflict");

const dismiss = () =>
	h.handler?.({
		input: {
			projectId: "project-1",
			storyId: "story-1",
			itemType: "story",
		},
	});

function story(lastPmSyncStatus: string | null): void {
	h.row = {
		id: "story-1",
		projectId: "project-1",
		lastPmSyncStatus,
		lastPmSyncError: lastPmSyncStatus === "CONFLICT" ? null : "x",
	};
}

beforeEach(() => {
	story("CONFLICT");
});

describe("dismissPmSyncConflictProcedure", () => {
	it("re-arms a CONFLICT row as SUCCESS", async () => {
		await expect(dismiss()).resolves.toEqual({ dismissed: true });
		expect(h.row.lastPmSyncStatus).toBe("SUCCESS");
	});

	it("leaves a row a newer sync stamped PENDING untouched", async () => {
		story("PENDING");
		await expect(dismiss()).resolves.toEqual({ dismissed: true });
		expect(h.row.lastPmSyncStatus).toBe("PENDING");
	});
});
