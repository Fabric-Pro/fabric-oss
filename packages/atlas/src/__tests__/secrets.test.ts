import { describe, expect, it } from "vitest";
import { redactSecrets } from "../graph/secrets";

describe("redactSecrets", () => {
	it("redacts a PEM private key block", () => {
		const content =
			"before\n-----BEGIN PRIVATE KEY-----\nMIIBVwIBADAN\n-----END PRIVATE KEY-----\nafter";
		const { redacted, count } = redactSecrets(content);
		expect(redacted).toContain("[REDACTED]");
		expect(redacted).not.toContain("MIIBVwIBADAN");
		expect(count).toBeGreaterThanOrEqual(1);
	});

	it("redacts assigned secrets but keeps the key name", () => {
		const { redacted, count } = redactSecrets(
			`const apiKey = "sk-supersecretvalue1234";`,
		);
		expect(redacted).toContain("apiKey");
		expect(redacted).toContain("[REDACTED]");
		expect(redacted).not.toContain("sk-supersecretvalue1234");
		expect(count).toBeGreaterThanOrEqual(1);
	});

	it("leaves ordinary code untouched", () => {
		const code = "export function add(a, b) { return a + b; }";
		const { redacted, count } = redactSecrets(code);
		expect(redacted).toBe(code);
		expect(count).toBe(0);
	});
});
