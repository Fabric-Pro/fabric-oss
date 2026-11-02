import { describe, expect, it } from "vitest";
import { validateOpenAPIBaseUrl } from "../base-url";

describe("OpenAPI base URL validation", () => {
	it.each(["http://127.0.0.1", "http://10.0.0.1", "file:///etc/passwd"])(
		"rejects %s before service writes",
		(baseUrl) => {
			expect(() => validateOpenAPIBaseUrl(baseUrl)).toThrow(
				"OpenAPI base URL must be a permitted public address",
			);
		},
	);

	it("accepts a public URL and an unset URL", () => {
		expect(() =>
			validateOpenAPIBaseUrl("https://api.example.com/v1"),
		).not.toThrow();
		expect(() => validateOpenAPIBaseUrl(null)).not.toThrow();
	});
});
