/**
 * Pausing a monitored Teams chat writes one timestamp and nothing else
 * (Fizzy #2355).
 *
 * The point of the shape is what it does NOT do: no seen-message row, no
 * cursor, no context, no vector. If a future change starts deleting alongside
 * the pause, the safe half of the unlink fork stops being safe and the
 * confirmation dialog starts lying — so this suite asserts the absence.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		projectFindFirst: vi.fn(),
		linkedFindFirst: vi.fn(),
		deactivate: vi.fn(),
		reactivate: vi.fn(),
		recordAudit: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	db: {
		project: { findFirst: mocks.projectFindFirst },
		projectLinkedTeamsChat: { findFirst: mocks.linkedFindFirst },
	},
	deactivateLinkedTeamsChat: (...a: unknown[]) => mocks.deactivate(...a),
	reactivateLinkedTeamsChat: (...a: unknown[]) => mocks.reactivate(...a),
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...a: unknown[]) => mocks.recordAudit(...a),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.setActive = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: {
			PROJECT_SETTINGS_EDIT: "project:settings:edit",
			PROJECT_UPDATE: "project:update",
		},
		requireProjectPermission: (permission: string) => {
			handlers.declaredPermission = () => permission;
			return (c: unknown) => c;
		},
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? undefined,
	};
});

await import("../set-chat-active");

const ctx = { user: { id: "user-1" } };

const call = (active: boolean) =>
	(handlers.setActive as (a: unknown) => Promise<Record<string, unknown>>)({
		input: {
			projectId: "project-1",
			organizationId: "org-1",
			linkedChatId: "chat-row-1",
			active,
		},
		context: ctx,
	});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.projectFindFirst.mockResolvedValue({
		id: "project-1",
		organizationId: "org-1",
	});
	mocks.linkedFindFirst.mockResolvedValue({ id: "chat-row-1" });
	mocks.deactivate.mockResolvedValue({
		id: "chat-row-1",
		deactivatedAt: new Date("2026-09-07T10:00:00Z"),
	});
	mocks.reactivate.mockResolvedValue({
		id: "chat-row-1",
		deactivatedAt: null,
	});
});

describe("setChatActiveProcedure", () => {
	it("is gated at the admin rung, matching the destructive half of the pair", () => {
		expect((handlers.declaredPermission as () => string)()).toBe(
			"project:settings:edit",
		);
	});

	it("pauses by writing a timestamp and recording who did it", async () => {
		const result = await call(false);

		expect(mocks.deactivate).toHaveBeenCalledWith({
			projectId: "project-1",
			linkedChatId: "chat-row-1",
			userId: "user-1",
		});
		expect(mocks.reactivate).not.toHaveBeenCalled();
		expect(result.deactivatedAt).toEqual(new Date("2026-09-07T10:00:00Z"));
	});

	it("resumes by clearing it", async () => {
		const result = await call(true);

		expect(mocks.reactivate).toHaveBeenCalledWith({
			projectId: "project-1",
			linkedChatId: "chat-row-1",
		});
		expect(mocks.deactivate).not.toHaveBeenCalled();
		expect(result.deactivatedAt).toBeNull();
	});

	it("scopes the lookup by project, so an id from another project misses", async () => {
		await call(false);

		expect(mocks.linkedFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "chat-row-1", projectId: "project-1" },
			}),
		);
	});

	it("takes the tenant from the authorized project, never from the input", async () => {
		mocks.projectFindFirst.mockResolvedValue({
			id: "project-1",
			organizationId: "org-from-the-row",
		});

		await call(false);

		expect(mocks.recordAudit).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({ organizationId: "org-from-the-row" }),
		);
	});

	it("records the pause under the context-source audit action", async () => {
		await call(false);

		expect(mocks.recordAudit).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				action: "project.context_source.scan_stopped",
				metadata: {
					provider: "MICROSOFT_TEAMS_CHAT",
					active: false,
				},
			}),
		);
	});

	it("404s on a chat that is not linked to this project", async () => {
		mocks.linkedFindFirst.mockResolvedValue(null);

		await expect(call(false)).rejects.toThrow(/Linked chat not found/);
		expect(mocks.deactivate).not.toHaveBeenCalled();
	});

	it("404s when the project does not resolve", async () => {
		mocks.projectFindFirst.mockResolvedValue(null);

		await expect(call(false)).rejects.toThrow(/Project not found/);
		expect(mocks.deactivate).not.toHaveBeenCalled();
	});
});
