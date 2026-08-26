import { describe, expect, it } from "vitest";
import { assertSubjectToRls } from "./rls-role";

describe("assertSubjectToRls", () => {
	it("passes for the restricted role with both bypass flags off", () => {
		expect(() =>
			assertSubjectToRls({
				who: "fabric_rls_test",
				is_super: false,
				bypass: false,
			}),
		).not.toThrow();
	});

	it("throws when the role is a superuser (rolsuper bypasses RLS independently)", () => {
		expect(() =>
			assertSubjectToRls({
				who: "fabric_rls_test",
				is_super: true,
				bypass: false,
			}),
		).toThrow(/false pass/);
	});

	it("throws when the role has BYPASSRLS", () => {
		expect(() =>
			assertSubjectToRls({
				who: "fabric_rls_test",
				is_super: false,
				bypass: true,
			}),
		).toThrow(/false pass/);
	});

	it("throws when running as the wrong role", () => {
		expect(() =>
			assertSubjectToRls({
				who: "postgres",
				is_super: false,
				bypass: false,
			}),
		).toThrow(/false pass/);
	});

	it("throws when the row is missing", () => {
		expect(() => assertSubjectToRls(undefined)).toThrow(/false pass/);
	});
});
