import { beforeEach, describe, expect, it, vi } from "vitest";

const { registeredHandler } = vi.hoisted(() => ({
	registeredHandler: {
		fn: undefined as ((...args: unknown[]) => unknown) | undefined,
	},
}));

vi.mock("@repo/database", () => ({
	getMfaPromptState: vi.fn(),
	GATEWAY_PROVIDERS: [],
	DB_GATEWAY_PROVIDERS: [],
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			registeredHandler.fn = fn;
			return { _handler: fn };
		},
	});
	return { protectedProcedure: chainable };
});

import { getMfaPromptState } from "@repo/database";

import "../get-state";

function makeContext(userId = "user-1") {
	return { user: { id: userId } };
}

describe("getMfaPromptState procedure", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns dismissed: false and snoozedUntil: null for a fresh user", async () => {
		vi.mocked(getMfaPromptState).mockResolvedValueOnce({
			dismissed: false,
			snoozedUntil: null,
		});

		const result = await registeredHandler.fn!({ context: makeContext() });

		expect(result).toEqual({ dismissed: false, snoozedUntil: null });
		expect(getMfaPromptState).toHaveBeenCalledWith("user-1");
	});

	it("returns dismissed: true after permanent dismissal", async () => {
		vi.mocked(getMfaPromptState).mockResolvedValueOnce({
			dismissed: true,
			snoozedUntil: null,
		});

		const result = await registeredHandler.fn!({ context: makeContext() });

		expect(result).toEqual({ dismissed: true, snoozedUntil: null });
	});

	it("returns correct snoozedUntil value after snooze", async () => {
		const snoozedUntil = new Date("2026-05-04T00:00:00Z");
		vi.mocked(getMfaPromptState).mockResolvedValueOnce({
			dismissed: false,
			snoozedUntil,
		});

		const result = await registeredHandler.fn!({ context: makeContext() });

		expect(result).toEqual({ dismissed: false, snoozedUntil });
	});
});
