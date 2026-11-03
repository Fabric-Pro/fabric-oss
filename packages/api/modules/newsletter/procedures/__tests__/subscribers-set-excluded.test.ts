/**
 * An admin can leave one org-synced person out of the release notes and bring
 * them back (Fizzy #1986, FR11, FR12).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { projectFindUnique, setExcluded, permission } = vi.hoisted(() => ({
	projectFindUnique: vi.fn(),
	setExcluded: vi.fn(),
	permission: vi.fn(
		(..._args: unknown[]) =>
			(c: unknown) =>
				c,
	),
}));

vi.mock("@repo/database", () => ({
	db: { project: { findUnique: projectFindUnique } },
	setOrganizationSubscriberExcluded: setExcluded,
}));

vi.mock("../../../../orpc/procedures", () => {
	// biome-ignore lint/suspicious/noExplicitAny: minimal chainable test double
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	};
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: permission,
	};
});

import { setSubscriberExcludedProcedure } from "../subscribers-set-excluded";

const gate = permission.mock.calls[0]?.[0];

const handler = (
	setSubscriberExcludedProcedure as unknown as {
		_handler: (args: { input: unknown }) => Promise<unknown>;
	}
)._handler;

const INPUT = {
	projectId: "p1",
	organizationId: "org-9",
	id: "sub_1",
	excluded: true,
};

beforeEach(() => {
	vi.clearAllMocks();
	projectFindUnique.mockResolvedValue({ id: "p1", organizationId: "org-9" });
	setExcluded.mockResolvedValue({ count: 1 });
});

describe("setSubscriberExcludedProcedure", () => {
	it("requires the settings permission", () => {
		expect(gate).toBe("PROJECT_SETTINGS_EDIT");
	});

	it("excludes the subscriber", async () => {
		await expect(handler({ input: INPUT })).resolves.toEqual({
			success: true,
		});
		expect(setExcluded).toHaveBeenCalledWith("p1", "sub_1", true);
	});

	it("restores the subscriber", async () => {
		await handler({ input: { ...INPUT, excluded: false } });

		expect(setExcluded).toHaveBeenCalledWith("p1", "sub_1", false);
	});

	it("refuses a row that is not org-synced in this project", async () => {
		setExcluded.mockResolvedValue({ count: 0 });

		await expect(handler({ input: INPUT })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});

	it("refuses an organization that does not own the project", async () => {
		await expect(
			handler({ input: { ...INPUT, organizationId: "org-other" } }),
		).rejects.toThrow();
		expect(setExcluded).not.toHaveBeenCalled();
	});
});
