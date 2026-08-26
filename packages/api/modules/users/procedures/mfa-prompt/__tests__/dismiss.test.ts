import { beforeEach, describe, expect, it, vi } from "vitest";

const { registeredHandler } = vi.hoisted(() => ({
	registeredHandler: {
		fn: undefined as ((...args: unknown[]) => unknown) | undefined,
	},
}));

vi.mock("@repo/database", () => ({
	dismissMfaPrompt: vi.fn(),
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

import { dismissMfaPrompt } from "@repo/database";

import "../dismiss";

function makeContext(userId = "user-1") {
	return { user: { id: userId } };
}

describe("dismissMfaPrompt procedure", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("calls dismissMfaPrompt with snooze action and returns success", async () => {
		vi.mocked(dismissMfaPrompt).mockResolvedValueOnce(undefined);

		const result = await registeredHandler.fn!({
			context: makeContext(),
			input: { action: "snooze" },
		});

		expect(result).toEqual({ success: true });
		expect(dismissMfaPrompt).toHaveBeenCalledWith("user-1", "snooze");
	});

	it("calls dismissMfaPrompt with dismiss action and returns success", async () => {
		vi.mocked(dismissMfaPrompt).mockResolvedValueOnce(undefined);

		const result = await registeredHandler.fn!({
			context: makeContext(),
			input: { action: "dismiss" },
		});

		expect(result).toEqual({ success: true });
		expect(dismissMfaPrompt).toHaveBeenCalledWith("user-1", "dismiss");
	});
});
