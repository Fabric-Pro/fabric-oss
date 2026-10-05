/**
 * One rule says what may be written into a command line: the arguments this CLI
 * hands to a coding tool and the lines it prints for a person to paste. A
 * deployment's address comes out of `new URL(...).origin`, which keeps `$ ( ) ;
 * & ` ' " ! ~ , { }` in a host, so the rule is an allowlist and not a list of
 * what to refuse.
 */
import { describe, expect, it } from "vitest";
import {
	isPlainOrigin,
	isSafeArgument,
	NO_COMMAND,
	NO_LINE_FOR_ADDRESS,
	pasteableLine,
} from "../src/lib/shell-words.js";

/** What `new URL(address).origin` gives for each, so the test is about what a command would meet. */
const HOSTILE_ADDRESSES = [
	"https://a.example.com$(id).x",
	"https://a.example.com&calc.exe",
	"https://a.example.com;ls",
	"https://a.example.com`id`",
	"https://a.example.com'x",
	'https://a.example.com"x',
	"https://a.example.com!x",
	"https://a.example.com~x",
	"https://a.example.com,x",
	"https://a.example.com{x}",
].map((address) => new URL(address).origin);

describe("isSafeArgument", () => {
	it.each([
		"mcp",
		"--scope",
		"fabric-pleone",
		"https://deploy.example.com/api/mcp-gateway/projects/project-1",
		"http://localhost:3001",
		"https://deploy.example.com:8443",
		"a_b.c+d=e@f",
	])("takes the plain word %s", (word) => {
		expect(isSafeArgument(word)).toBe(true);
	});

	it.each([
		"",
		"a b",
		"a\tb",
		"a\nb",
		"$(id)",
		"a;b",
		"a&b",
		"a|b",
		"`id`",
		"'a'",
		'"a"',
		"a!b",
		"a~b",
		"a,b",
		"a{b}",
		"a*b",
		"a?b",
		"a<b",
		"a>b",
		"a\\b",
		"a%b",
		"a^b",
		"a#b",
		"a(b",
		"[::1]",
	])("refuses %j", (word) => {
		expect(isSafeArgument(word)).toBe(false);
	});

	it.each(HOSTILE_ADDRESSES)("refuses the origin %s", (origin) => {
		expect(isSafeArgument(origin)).toBe(false);
	});
});

describe("pasteableLine", () => {
	it("joins plain words into one line", () => {
		expect(pasteableLine(["claude", "mcp", "login", "fabric"])).toBe(
			"claude mcp login fabric",
		);
	});

	it("is null when any one word is not plain, and does not say which", () => {
		expect(
			pasteableLine([
				"claude",
				"mcp",
				"add",
				"fabric",
				HOSTILE_ADDRESSES[0],
			]),
		).toBeNull();
		expect(pasteableLine(["codex", "mcp", "add", "my server"])).toBeNull();
	});
});

describe("isPlainOrigin", () => {
	it.each([
		"https://deploy.example.com",
		"http://localhost:3001",
		"https://staging.example.com:8443",
		"http://127.0.0.1:3001",
		"http://[::1]:3001",
		"https://xn--e1afmkfd.example",
	])("takes %s", (origin) => {
		expect(isPlainOrigin(origin)).toBe(true);
	});

	it.each([
		...HOSTILE_ADDRESSES,
		"https://deploy.example.com/path",
		"https://deploy.example.com?x=1",
		"ftp://deploy.example.com",
		"deploy.example.com",
		"",
		"https://",
	])("refuses %s", (origin) => {
		expect(isPlainOrigin(origin)).toBe(false);
	});
});

describe("the sentences that stand in for a line", () => {
	it("say what is wrong without repeating an address", () => {
		for (const sentence of [NO_COMMAND, NO_LINE_FOR_ADDRESS]) {
			expect(sentence).toContain("deployment");
			expect(sentence).not.toMatch(/https?:\/\//);
		}
	});
});
