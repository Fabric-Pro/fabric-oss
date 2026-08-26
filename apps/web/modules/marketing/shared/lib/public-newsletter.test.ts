import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { isPublicNewsletterEnabled } from "./public-newsletter";

const original = process.env.FABRIC_MAIN_PROJECT_ID;
afterEach(() => {
	process.env.FABRIC_MAIN_PROJECT_ID = original;
});

describe("isPublicNewsletterEnabled", () => {
	it("is true when the env is a non-empty id", () => {
		process.env.FABRIC_MAIN_PROJECT_ID = "fabric-main";
		expect(isPublicNewsletterEnabled()).toBe(true);
	});

	it("is false when unset or blank", () => {
		process.env.FABRIC_MAIN_PROJECT_ID = "";
		expect(isPublicNewsletterEnabled()).toBe(false);
		process.env.FABRIC_MAIN_PROJECT_ID = "   ";
		expect(isPublicNewsletterEnabled()).toBe(false);
	});
});
