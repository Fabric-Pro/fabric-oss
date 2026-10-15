import { describe, expect, it } from "vitest";
import {
	cloudflareAccountEndpoint,
	cloudflareMarkdownUrl,
	isCloudflareAccountId,
	parseCloudflareAccountId,
	redactCloudflareToken,
} from "../lib/cloudflare-browser-rendering";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const ENDPOINT = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`;

describe("isCloudflareAccountId", () => {
	it("accepts 32 lowercase hex characters", () => {
		expect(isCloudflareAccountId(ACCOUNT_ID)).toBe(true);
	});

	it.each([
		["too short", ACCOUNT_ID.slice(1)],
		["too long", `${ACCOUNT_ID}0`],
		["uppercase", ACCOUNT_ID.toUpperCase()],
		["non-hex", `${ACCOUNT_ID.slice(1)}g`],
		["surrounding whitespace", ` ${ACCOUNT_ID}`],
		["empty", ""],
	])("rejects %s", (_label, value) => {
		expect(isCloudflareAccountId(value)).toBe(false);
	});
});

describe("cloudflareAccountEndpoint", () => {
	it("builds the account-scoped API base URL", () => {
		expect(cloudflareAccountEndpoint(ACCOUNT_ID)).toBe(ENDPOINT);
	});

	it("throws rather than compose a URL from a bad account ID", () => {
		expect(() => cloudflareAccountEndpoint("../../evil")).toThrow(
			/32 lowercase hexadecimal/,
		);
	});
});

describe("parseCloudflareAccountId", () => {
	it("round-trips the builder", () => {
		expect(
			parseCloudflareAccountId(cloudflareAccountEndpoint(ACCOUNT_ID)),
		).toBe(ACCOUNT_ID);
	});

	it.each([
		["null", null],
		["undefined", undefined],
		["empty", ""],
		[
			"wrong host",
			`https://api.example.com/client/v4/accounts/${ACCOUNT_ID}`,
		],
		[
			"lookalike host",
			`https://api.cloudflare.com.example.com/client/v4/accounts/${ACCOUNT_ID}`,
		],
		["http scheme", ENDPOINT.replace("https://", "http://")],
		["trailing slash", `${ENDPOINT}/`],
		["extra path", `${ENDPOINT}/browser-rendering/markdown`],
		["query string", `${ENDPOINT}?x=1`],
		["short id", ENDPOINT.slice(0, -1)],
		["long id", `${ENDPOINT}0`],
		[
			"uppercase id",
			ENDPOINT.replace(ACCOUNT_ID, ACCOUNT_ID.toUpperCase()),
		],
		["userinfo", ENDPOINT.replace("https://", "https://user@")],
	])("returns null for %s", (_label, value) => {
		expect(parseCloudflareAccountId(value)).toBeNull();
	});
});

describe("cloudflareMarkdownUrl", () => {
	it("appends the Browser Rendering markdown path to a valid endpoint", () => {
		expect(cloudflareMarkdownUrl(ENDPOINT)).toBe(
			`${ENDPOINT}/browser-rendering/markdown`,
		);
	});

	it("returns null for an invalid endpoint", () => {
		expect(cloudflareMarkdownUrl("https://api.example.com")).toBeNull();
		expect(cloudflareMarkdownUrl(null)).toBeNull();
	});
});

describe("redactCloudflareToken", () => {
	const TOKEN = "cfTokenABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

	it("redacts every full echo of the token", () => {
		expect(
			redactCloudflareToken(`Bearer ${TOKEN} and again ${TOKEN}.`, TOKEN),
		).toBe("Bearer [redacted] and again [redacted].");
	});

	it("redacts a leading run of the token that upstream cut short", () => {
		const cut = TOKEN.slice(0, 20);
		const result = redactCloudflareToken(`header was ${cut}`, TOKEN);
		expect(result).toBe("header was [redacted]");
		expect(result).not.toContain(TOKEN.slice(0, 8));
	});

	it("leaves text without the token, and shorter coincidences, alone", () => {
		expect(redactCloudflareToken("Navigation timeout", TOKEN)).toBe(
			"Navigation timeout",
		);
		expect(redactCloudflareToken("cfToken is a word", TOKEN)).toBe(
			"cfToken is a word",
		);
	});

	it("is a no-op without a token", () => {
		expect(redactCloudflareToken("text", undefined)).toBe("text");
		expect(redactCloudflareToken("text", "")).toBe("text");
	});
});
