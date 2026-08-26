import { afterEach, describe, expect, it } from "vitest";
import { isMailConfigured } from "../send";

const original = process.env.RESEND_API_KEY;
afterEach(() => {
	process.env.RESEND_API_KEY = original;
});

describe("isMailConfigured", () => {
	it("is true when RESEND_API_KEY is set", () => {
		process.env.RESEND_API_KEY = "re_test";
		expect(isMailConfigured()).toBe(true);
	});
	it("is false when RESEND_API_KEY is missing", () => {
		delete process.env.RESEND_API_KEY;
		expect(isMailConfigured()).toBe(false);
	});
});
