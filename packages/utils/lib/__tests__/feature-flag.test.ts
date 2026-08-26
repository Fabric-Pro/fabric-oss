import { describe, expect, it } from "vitest";
import { parseOptInFlag } from "../feature-flag";

describe("parseOptInFlag (opt-in, default OFF)", () => {
	it.each(["true", "1", "on", "yes", "TRUE", " On "])(
		"enables for %p",
		(v) => {
			expect(parseOptInFlag(v)).toBe(true);
		},
	);
	it.each([undefined, "", "false", "0", "no", "off", "anything"])(
		"disables for %p",
		(v) => {
			expect(parseOptInFlag(v as string | undefined)).toBe(false);
		},
	);
});
