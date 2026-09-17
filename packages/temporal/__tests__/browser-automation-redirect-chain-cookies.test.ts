/**
 * Pure cookie helpers for the relay's same-origin redirect chains. The relay
 * never writes to the browser context's cookie store; these only shape the
 * headers it forwards.
 */
import { describe, expect, it } from "vitest";
import {
	defaultCookiePath,
	fulfillableSetCookies,
	isPartitionedSetCookie,
	withHopDefaultPath,
} from "../src/activities/browser-automation/redirect-chain-cookies";

describe("defaultCookiePath", () => {
	it.each([
		["https://a.example.com/", "/"],
		["https://a.example.com/login", "/"],
		["https://a.example.com/account/login", "/account"],
		["https://a.example.com/account/settings/", "/account/settings"],
	])("%s → %s", (url, path) => {
		expect(defaultCookiePath(new URL(url))).toBe(path);
	});
});

describe("withHopDefaultPath", () => {
	const hop = new URL("https://a.example.com/auth/step");

	it("adds the hop's default-path to a cookie that names none", () => {
		expect(withHopDefaultPath("sid=1; HttpOnly", hop)).toBe(
			"sid=1; HttpOnly; Path=/auth",
		);
	});

	it("keeps a cookie's own Path", () => {
		expect(withHopDefaultPath("sid=1; Path=/", hop)).toBe("sid=1; Path=/");
	});

	it("replaces a Path Chromium would ignore by appending the default", () => {
		expect(withHopDefaultPath("sid=1; Path=relative", hop)).toBe(
			"sid=1; Path=relative; Path=/auth",
		);
	});

	it("leaves an unparseable header alone", () => {
		expect(withHopDefaultPath("garbage", hop)).toBe("garbage");
	});
});

describe("Partitioned cookies", () => {
	it("recognises the attribute in any case and position", () => {
		expect(
			isPartitionedSetCookie("p=1; Secure; SameSite=None; Partitioned"),
		).toBe(true);
		expect(isPartitionedSetCookie("p=1; partitioned; Secure")).toBe(true);
		expect(isPartitionedSetCookie("p=1; Secure; Path=/Partitioned")).toBe(
			false,
		);
		expect(isPartitionedSetCookie("partitioned=1")).toBe(false);
	});

	it("keeps every other cookie in order and counts what it dropped", () => {
		expect(
			fulfillableSetCookies([
				"a=1",
				"p=1; Secure; SameSite=None; Partitioned",
				"b=2; Max-Age=0",
			]),
		).toEqual({ kept: ["a=1", "b=2; Max-Age=0"], droppedPartitioned: 1 });
	});
});
