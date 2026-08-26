import { describe, expect, it } from "vitest";
import {
	MAX_SCRUBBED_BODY_CHARS,
	scrubAndTrim,
	scrubSecrets,
} from "../scrub-secrets";

describe("scrubSecrets", () => {
	it("removes a literal secret wherever it appears", () => {
		const out = scrubSecrets(
			"sent glpat-abc123456 twice: glpat-abc123456",
			["glpat-abc123456"],
		);
		expect(out).not.toContain("glpat-abc123456");
		expect(out.match(/\[REDACTED\]/g)).toHaveLength(2);
	});

	it("replaces the longest secret first so no fragment survives", () => {
		// The short secret is a prefix of the long one. Replacing shortest-first
		// would consume the prefix and strand the remainder in the output.
		const out = scrubSecrets("token=abcdef123456", [
			"abcdef",
			"abcdef123456",
		]);
		expect(out).not.toContain("abcdef123456");
		expect(out).not.toMatch(/123456/);
	});

	it("ignores secrets too short to be secrets", () => {
		// A 5-character value matches too much ordinary prose to redact safely.
		expect(scrubSecrets("the cat sat on the mat", ["cat"])).toBe(
			"the cat sat on the mat",
		);
	});

	it("catches credential-shaped patterns it was never told about", () => {
		const out = scrubSecrets(
			'Authorization: Bearer eyJhbGciOi.J9 and PRIVATE-TOKEN: glpat-unknown "api_key": "sk-live-xyz"',
		);
		expect(out).not.toContain("eyJhbGciOi.J9");
		expect(out).not.toContain("glpat-unknown");
		expect(out).not.toContain("sk-live-xyz");
	});

	it("leaves an innocent body untouched", () => {
		const body = "reference not found; check the branch name";
		expect(scrubSecrets(body, ["glpat-abc123456"])).toBe(body);
	});

	// The likeliest secret in a test failure, and the one the named-key rules
	// all miss: the credential is positional, not `key=value`. A connection
	// error prints the whole DSN — Prisma, node-postgres, redis and mongo all
	// do it.
	it.each([
		[
			"Error: connect ECONNREFUSED postgresql://admin:hunter2@db.internal:5432/fabric",
			"hunter2",
		],
		["datasource db url postgres://u:p4ssw0rd@10.0.0.5/app", "p4ssw0rd"],
		["redis://default:sEcReT123@cache:6379", "sEcReT123"],
		["mongodb+srv://root:topsecret@cluster0.mongodb.net/test", "topsecret"],
		["amqps://svc:rabbitpw@broker:5671/vhost", "rabbitpw"],
	])("redacts the password out of %s", (body, password) => {
		const out = scrubSecrets(body);
		expect(out).not.toContain(password);
		expect(out).toContain("[REDACTED]");
	});

	it("keeps the scheme, user and host — they are the diagnosis, not the secret", () => {
		const out = scrubSecrets(
			"connect ECONNREFUSED postgresql://admin:hunter2@db.internal:5432/fabric",
		);
		expect(out).toContain("postgresql://admin:");
		expect(out).toContain("@db.internal:5432/fabric");
		expect(out).toContain("ECONNREFUSED");
	});

	it("leaves ordinary URLs alone", () => {
		// No userinfo at all, and a userinfo with no password — neither carries
		// a credential, and mangling them would corrupt a useful error.
		for (const url of [
			"https://gitlab.com/api/v4/projects/1/pipeline",
			"see https://docs.example.com/ci#setup for the fix",
			"ssh://git@github.com/acme/store.git",
		]) {
			expect(scrubSecrets(url)).toBe(url);
		}
	});
});

describe("scrubAndTrim", () => {
	it("scrubs BEFORE truncating, so a cut cannot leave half a credential", () => {
		// Truncate-then-scrub would slice the token and leave its first half in
		// the output, reading as redacted while still being a usable prefix.
		const secret = "glpat-0123456789abcdef";
		const body = `${"x".repeat(MAX_SCRUBBED_BODY_CHARS - 10)}${secret}`;
		const out = scrubAndTrim(body, [secret]);
		expect(out).not.toContain("glpat-0123");
	});

	it("collapses whitespace and caps the length", () => {
		const out = scrubAndTrim(`a\n\n   b   ${"c".repeat(500)}`);
		expect(out.startsWith("a b ")).toBe(true);
		expect(out.length).toBeLessThanOrEqual(MAX_SCRUBBED_BODY_CHARS + 1);
	});
});
