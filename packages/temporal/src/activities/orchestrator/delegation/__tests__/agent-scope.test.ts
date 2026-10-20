import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	db: {},
}));

import { isExternalAgentScope } from "../resolve-endpoint";

describe("isExternalAgentScope", () => {
	it.each([
		["SYSTEM", false],
		["USER", true],
		["ORGANIZATION", true],
		["", true],
		["system", true],
		["UNKNOWN", true],
	])("classifies scope %j as external=%j", (scope, external) => {
		expect(isExternalAgentScope(scope)).toBe(external);
	});
});
