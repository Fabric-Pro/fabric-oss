import { describe, expect, it } from "vitest";
import {
	REDACTED,
	redactQuery,
	redactUrl,
	UNPARSEABLE_URL,
	undiciRedactedUrlAttributes,
} from "../lib/url-redaction";

describe("redactQuery", () => {
	it("replaces every value and keeps plain keys", () => {
		expect(redactQuery("?sig=abc&se=2030&name=report.pdf")).toBe(
			"?sig=REDACTED&se=REDACTED&name=REDACTED",
		);
		expect(redactQuery("X-Amz-Signature=deadbeef&X-Amz-Expires=60")).toBe(
			"X-Amz-Signature=REDACTED&X-Amz-Expires=REDACTED",
		);
	});

	it("keeps repeated keys and empty values as separate redacted pairs", () => {
		expect(redactQuery("?a=1&a=2&b=")).toBe(
			"?a=REDACTED&a=REDACTED&b=REDACTED",
		);
	});

	it("redacts percent-encoded values and keys that are not plain", () => {
		expect(redactQuery("?sig=ab%2Bcd%3D%3D")).toBe("?sig=REDACTED");
		// An encoded key could carry a value; it is replaced as a whole.
		expect(redactQuery("?si%67=secret&a+b=c")).toBe(
			"?REDACTED=REDACTED&REDACTED=REDACTED",
		);
		expect(redactQuery("?sig%3Dsecret")).toBe("?REDACTED");
	});

	it("treats a bare token as a value and drops empty segments", () => {
		expect(redactQuery("?SECRETTOKEN&&a=1")).toBe("?REDACTED&a=REDACTED");
	});

	it("leaves an empty query empty", () => {
		expect(redactQuery("")).toBe("");
		expect(redactQuery("?")).toBe("");
	});
});

describe("redactUrl", () => {
	it("redacts query values, userinfo and fragment", () => {
		expect(
			redactUrl(
				"https://user:pass@storage.example.com/c/blob.bin?sv=2024&sig=abc%2F%3D#token=xyz",
			),
		).toBe(
			"https://storage.example.com/c/blob.bin?sv=REDACTED&sig=REDACTED",
		);
	});

	it("strips a username without a password", () => {
		expect(redactUrl("https://token@api.example.com/v1")).toBe(
			"https://api.example.com/v1",
		);
	});

	it("leaves a URL with no query, userinfo or fragment unchanged", () => {
		const url = "https://api.example.com:8443/v1/items";
		expect(redactUrl(url)).toBe(url);
	});

	it("never passes an unparseable URL through", () => {
		for (const value of ["", "not a url?sig=secret", "http://[::1"]) {
			expect(redactUrl(value)).toBe(UNPARSEABLE_URL);
		}
	});
});

describe("undiciRedactedUrlAttributes", () => {
	it("builds the URL the way undici instrumentation does and redacts it", () => {
		expect(
			undiciRedactedUrlAttributes({
				origin: "https://bucket.example.com",
				path: "/key?X-Amz-Signature=abc&X-Amz-Credential=AKIA%2F",
			}),
		).toEqual({
			"url.full": `https://bucket.example.com/key?X-Amz-Signature=${REDACTED}&X-Amz-Credential=${REDACTED}`,
			"url.query": `?X-Amz-Signature=${REDACTED}&X-Amz-Credential=${REDACTED}`,
		});
	});

	it("strips userinfo carried in the origin", () => {
		expect(
			undiciRedactedUrlAttributes({
				origin: "https://user:pass@api.example.com",
				path: "/v1",
			}),
		).toEqual({
			"url.full": "https://api.example.com/v1",
			"url.query": "",
		});
	});

	it("returns placeholders when the request URL cannot be built", () => {
		expect(
			undiciRedactedUrlAttributes({
				origin: "not-an-origin",
				path: "?sig=s",
			}),
		).toEqual({
			"url.full": UNPARSEABLE_URL,
			"url.query": UNPARSEABLE_URL,
		});
		expect(undiciRedactedUrlAttributes({})).toEqual({
			"url.full": UNPARSEABLE_URL,
			"url.query": UNPARSEABLE_URL,
		});
	});
});
