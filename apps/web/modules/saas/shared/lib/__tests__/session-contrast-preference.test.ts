/**
 * What the server layout renders for a stored contrast preference (Fizzy
 * #1444, AC-4/5/6): the stored value when it is one this build knows, the
 * standard palette otherwise — silently for "never chose", with a log line for
 * a value that should not be there.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));

vi.mock("@repo/logs", () => ({ logger: { warn: warnMock } }));

import { sessionContrastPreference } from "../session-contrast-preference";

beforeEach(() => {
	warnMock.mockReset();
});

describe("sessionContrastPreference", () => {
	it.each(["high", "standard"] as const)(
		"renders a stored %s as stored",
		(stored) => {
			expect(
				sessionContrastPreference({
					id: "u1",
					contrastPreference: stored,
				}),
			).toBe(stored);
			expect(warnMock).not.toHaveBeenCalled();
		},
	);

	it.each([null, undefined, ""])(
		"renders the standard palette, unlogged, for no choice (%s)",
		(stored) => {
			expect(
				sessionContrastPreference({
					id: "u1",
					contrastPreference: stored,
				}),
			).toBe("standard");
			expect(warnMock).not.toHaveBeenCalled();
		},
	);

	it("renders the standard palette and logs a value it cannot read (AC-6)", () => {
		expect(
			sessionContrastPreference({
				id: "u1",
				contrastPreference: "ultra",
			}),
		).toBe("standard");
		expect(warnMock).toHaveBeenCalledTimes(1);
		expect(warnMock).toHaveBeenCalledWith(
			expect.stringContaining("Unrecognised contrast preference"),
			{ userId: "u1", storedPreference: "ultra" },
		);
	});

	it("bounds what it logs", () => {
		sessionContrastPreference({
			id: "u1",
			contrastPreference: "x".repeat(10_000),
		});
		const [, meta] = warnMock.mock.calls[0] ?? [];
		expect(
			(meta as { storedPreference: string }).storedPreference,
		).toHaveLength(64);
	});
});
