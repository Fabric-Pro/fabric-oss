import { describe, expect, it } from "vitest";
import {
	type LinkableCase,
	parseTcTagNumber,
	resolveAutomationLink,
} from "../automation-linkage";

const cases: LinkableCase[] = [
	{
		id: "c1",
		identifier: "TC-014",
		title: "User can reset password",
		automationRef: "resets the password",
		automationFilePath: "tests/auth/reset.spec.ts",
	},
	{
		id: "c2",
		identifier: "TC-020",
		title: "Login succeeds",
		automationRef: "login succeeds",
		automationFilePath: null,
	},
];

describe("parseTcTagNumber", () => {
	it("extracts the case NUMBER from arbitrary test text, ignoring padding", () => {
		expect(parseTcTagNumber("login succeeds @TC-14")).toBe(14);
		expect(parseTcTagNumber("[tc-020] does a thing")).toBe(20);
		expect(parseTcTagNumber("covers TC-007")).toBe(7);
		expect(parseTcTagNumber("TC-1234 big project")).toBe(1234);
		expect(parseTcTagNumber("no tag here")).toBeNull();
		expect(parseTcTagNumber(null)).toBeNull();
		expect(parseTcTagNumber(undefined)).toBeNull();
	});
});

describe("resolveAutomationLink — hybrid cascade (first hit wins)", () => {
	it("tier 1: an explicit @TC tag wins over an otherwise-matching title", () => {
		// "login succeeds" would title-match c2, but the tag names c1.
		const m = resolveAutomationLink(
			{ name: "login succeeds @TC-014" },
			cases,
		);
		expect(m).toEqual({ caseId: "c1", tier: "tag", matchedOn: "TC-014" });
	});

	it("tier 1: an UNPADDED tag matches the zero-padded identifier", () => {
		// Regression: identifiers are minted `TC-014` but authors write `@TC-14`.
		// A string compare missed every case below TC-100, and the deliberate
		// no-downgrade rule below then threw away the title match that would
		// otherwise have worked — so tagging was worse than not tagging.
		const m = resolveAutomationLink({ name: "resets pw @TC-14" }, cases);
		expect(m).toEqual({ caseId: "c1", tier: "tag", matchedOn: "TC-014" });
	});

	it("tier 1: a tag that names no case is unmatched, not downgraded to a title guess", () => {
		expect(
			resolveAutomationLink({ name: "login succeeds @TC-999" }, cases),
		).toBeNull();
	});

	it("tier 2: file-qualified ref match (path beats title)", () => {
		const m = resolveAutomationLink({ name: "resets the password" }, cases);
		expect(m).toEqual({
			caseId: "c1",
			tier: "path",
			matchedOn: "resets the password",
		});
	});

	it("tier 3: title/ref match with no file qualifier", () => {
		const m = resolveAutomationLink({ name: "login succeeds" }, cases);
		expect(m?.caseId).toBe("c2");
		expect(m?.tier).toBe("title");
	});

	it("matches on describe + it (classname + name) text", () => {
		const m = resolveAutomationLink(
			{ name: "succeeds", classname: "login" },
			[
				{
					id: "c3",
					identifier: "TC-030",
					title: "Login succeeds",
					automationRef: "login succeeds",
					automationFilePath: null,
				},
			],
		);
		expect(m?.caseId).toBe("c3");
	});

	it("returns null when nothing matches (the unmatched bucket)", () => {
		expect(
			resolveAutomationLink({ name: "totally unrelated test" }, cases),
		).toBeNull();
	});
});
