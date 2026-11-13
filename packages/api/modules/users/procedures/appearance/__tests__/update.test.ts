/**
 * Saving the high-contrast theme choice (Fizzy #1444).
 *
 * The preference is the signed-in person's own: it is written to their row and
 * nobody else's, a value outside the known set never reaches the database, and
 * an admin impersonating them changes their page without changing their
 * account.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { registered } = vi.hoisted(() => ({
	registered: {
		handler: undefined as ((...args: unknown[]) => unknown) | undefined,
		input: undefined as
			| { safeParse: (value: unknown) => { success: boolean } }
			| undefined,
	},
}));

vi.mock("@repo/database", () => ({
	updateUserContrastPreference: vi.fn(),
	GATEWAY_PROVIDERS: [],
	DB_GATEWAY_PROVIDERS: [],
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: (schema: typeof registered.input) => {
			registered.input = schema;
			return chainable;
		},
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			registered.handler = fn;
			return { _handler: fn };
		},
	});
	return { protectedProcedure: chainable };
});

import { updateUserContrastPreference } from "@repo/database";

import "../update";

function context(overrides: { impersonatedBy?: string | null } = {}) {
	return {
		user: { id: "user-1" },
		session: {
			id: "session-1",
			impersonatedBy: overrides.impersonatedBy ?? null,
		},
	};
}

describe("users.appearance.update", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it.each(["high", "standard"] as const)(
		"saves %s on the signed-in person's own account",
		async (contrastPreference) => {
			vi.mocked(updateUserContrastPreference).mockResolvedValueOnce(
				contrastPreference,
			);

			const result = await registered.handler?.({
				context: context(),
				input: { contrastPreference },
			});

			expect(updateUserContrastPreference).toHaveBeenCalledWith(
				"user-1",
				contrastPreference,
			);
			expect(result).toEqual({ contrastPreference, persisted: true });
		},
	);

	it("accepts only the known preferences", () => {
		expect(
			registered.input?.safeParse({ contrastPreference: "high" }).success,
		).toBe(true);
		expect(
			registered.input?.safeParse({ contrastPreference: "standard" })
				.success,
		).toBe(true);
		for (const value of ["HIGH", "dark", "", null, undefined, 1]) {
			expect(
				registered.input?.safeParse({ contrastPreference: value })
					.success,
				`${String(value)} should be refused`,
			).toBe(false);
		}
	});

	it("does not touch the account while an admin is impersonating it", async () => {
		const result = await registered.handler?.({
			context: context({ impersonatedBy: "admin-1" }),
			input: { contrastPreference: "high" },
		});

		expect(updateUserContrastPreference).not.toHaveBeenCalled();
		expect(result).toEqual({
			contrastPreference: "high",
			persisted: false,
		});
	});

	it("lets a database failure surface so the browser can say it was not saved", async () => {
		vi.mocked(updateUserContrastPreference).mockRejectedValueOnce(
			new Error("connection reset"),
		);

		await expect(
			registered.handler?.({
				context: context(),
				input: { contrastPreference: "high" },
			}),
		).rejects.toThrow("connection reset");
	});
});
