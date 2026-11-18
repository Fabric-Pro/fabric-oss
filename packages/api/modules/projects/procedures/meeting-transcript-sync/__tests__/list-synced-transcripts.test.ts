/**
 * Unit tests for `listSyncedTranscriptsProcedure`.
 *
 * A sync that recovers missed meetings stores them all in one run, after
 * newer meetings were stored. Ordered by storage time, the recovered batch sat
 * above the newest meetings, so the list must be ordered by when each meeting
 * took place.
 *
 * Handler-capture + mocked-builder pattern mirrors the sibling
 * `get-transcript-content.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		transcriptFindMany: vi.fn(),
		hasProjectAccess: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		db: {
			projectMeetingTranscript: {
				findMany: (...args: unknown[]) =>
					mocks.transcriptFindMany(...args),
			},
		},
		hasProjectAccess: (...args: unknown[]) =>
			mocks.hasProjectAccess(...args),
	};
});

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.list = fn;
			return { _handler: fn };
		},
	});

	return {
		tenantProtectedProcedure: chainable,
		Permissions: { PROJECT_READ: "project:read" },
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (
			organizationId: string | null | undefined,
			_session: unknown,
		) => organizationId ?? undefined,
	};
});

await import("../list-synced-transcripts");

const ctx = { user: { id: "user-1" }, session: {} };

beforeEach(() => {
	mocks.transcriptFindMany.mockReset();
	mocks.transcriptFindMany.mockResolvedValue([]);
	mocks.hasProjectAccess.mockReset();
	mocks.hasProjectAccess.mockResolvedValue(true);
});

describe("listSyncedTranscriptsProcedure", () => {
	it("lists the newest meeting first, not the most recently stored", async () => {
		await handlers.list({
			input: { projectId: "proj-1", organizationId: "org-1" },
			context: ctx,
		});

		expect(mocks.transcriptFindMany).toHaveBeenCalledWith({
			where: { projectId: "proj-1" },
			orderBy: [
				{ meetingDate: { sort: "desc", nulls: "last" } },
				{ syncedAt: "desc" },
			],
		});
	});

	it("scopes the list to one linked meeting when asked", async () => {
		await handlers.list({
			input: { projectId: "proj-1", linkedMeetingId: "linked-1" },
			context: ctx,
		});

		expect(mocks.transcriptFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { projectId: "proj-1", linkedMeetingId: "linked-1" },
			}),
		);
	});

	it("refuses a caller without project access", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);

		await expect(
			handlers.list({ input: { projectId: "proj-1" }, context: ctx }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.transcriptFindMany).not.toHaveBeenCalled();
	});
});
