import { describe, expect, it } from "vitest";
import { isSecretFileName, scanTextForSecrets } from "../src/secrets";

// Positive fixtures are assembled at runtime from fragments so no
// secret-shaped literal ever appears in this source file (gitleaks has no
// test-path allowlist here and would otherwise refuse the commit/relay).
const join = (...parts: string[]) => parts.join("");

const SECRET_LINES: ReadonlyArray<readonly [string, string]> = [
	["aws-access-key", `key = ${join("AKIA", "IOSFODNN7EXAMPLE")}`],
	[
		"github-token",
		`token: ${join("ghp_", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij")}`,
	],
	[
		"slack-token",
		`SLACK=${["xoxb", "123456789012", "1234567890123", "AbCdEfGhIjKlMnOpQrStUvWx"].join("-")}`,
	],
	[
		"openai-key",
		`OPENAI_API_KEY=${join("sk-proj-", "abcdefghijklmnopqrstuvwxyz0123456789")}`,
	],
	[
		"anthropic-key",
		join(
			"sk-ant-",
			"api03-",
			"abcdefghijklmnopqrstuvwxyz0123456789abcdefghij",
		),
	],
	["google-api-key", join("AIza", "SyA1234567890abcdefghijklmnopqrstuvw")],
	["private-key-block", join("-----BEGIN ", "RSA PRIVATE KEY", "-----")],
	[
		"jwt",
		[
			"eyJhbGciOiJIUzI1NiJ9",
			"eyJzdWIiOiIxMjM0In0",
			"abcdefghijklmnopqrstuvwxyz012345",
		].join("."),
	],
	[
		"bearer-header",
		`Authorization: Bearer ${join("abcdefghijklmnopqrstuvwxyz0123456789", "ABCD")}`,
	],
	[
		"azure-devops-pat",
		`AZURE_DEVOPS_PAT=${join("abcdefghijklmnopqrstuvwxyz0123456789", "abcdefghijklmnop")}`,
	],
	[
		"connection-string-password",
		`Server=db.example.com;Password=${join("SuperSecret", "123!")};`,
	],
	[
		"generic-assignment",
		`api_key: "${join("9f8e7d6c5b4a3928", "1706f5e4d3c2b1a0")}"`,
	],
	[
		"generic-assignment",
		`DB_PASSWORD=${join("9f8e7d6c5b4a3928", "1706f5e4d3c2b1a0")}`,
	],
	["short-credential-assignment", `password: ${join("123abcd", "raja")}`],
	["short-credential-assignment", `DB_PASSWORD="${join("s3cr3t", "Pass")}"`],
	["short-credential-assignment", `github-token = ${join("abc", "12345")}`],
];

describe("scanTextForSecrets", () => {
	it.each(SECRET_LINES)("%s is detected", (rule, line) => {
		const hits = scanTextForSecrets(`line one\n${line}\nline three`);
		expect(hits).toEqual([{ rule, line: 2 }]);
	});

	it.each([
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder text, not interpolation
		"Authorization: Bearer ${ADO_PAT}",
		"Authorization: Bearer $TOKEN",
		"api_key: <your key here>",
		"password: ***REDACTED***",
		"Use `az account get-access-token` to mint a token.",
		"token = process.env.GITHUB_TOKEN",
		'export PAT="$(security find-generic-password -s ado -w)"',
		"password: required",
		"token: expired",
		"password: ab12",
		"secret: changeme",
		"token: expires after 3600 seconds",
		"PASSWORD_HASH_ROUNDS=12",
	])("%s is not a secret", (line) => {
		expect(scanTextForSecrets(line)).toEqual([]);
	});
});

/**
 * The bounded form (Fizzy #2737 review). A dense file — a credential
 * assignment on every short line — used to materialise one hit object per
 * line before any cap downstream could drop them. With `limit` the scan keeps
 * at most that many and only counts the rest, so the array it builds IS the
 * retained collection, and its length is the bound.
 */
describe("scanTextForSecrets with a limit", () => {
	const DENSE_LINES = 20_000;
	const dense = Array.from(
		{ length: DENSE_LINES },
		(_, i) => `password: ${join("123abcd", "raja", String(i))}`,
	).join("\n");

	it("keeps no more than the limit, in line order, and counts every hit", () => {
		const scan = scanTextForSecrets(dense, { limit: 100 });
		expect(scan.hits).toHaveLength(100);
		expect(scan.hits[0]).toEqual({
			rule: "short-credential-assignment",
			line: 1,
		});
		expect(scan.hits[99]?.line).toBe(100);
		expect(scan.total).toBe(DENSE_LINES);
	});

	it("keeps nothing at a limit of zero but still says how many there are", () => {
		expect(scanTextForSecrets(dense, { limit: 0 })).toEqual({
			hits: [],
			total: DENSE_LINES,
		});
	});

	it("treats a negative limit as zero", () => {
		expect(scanTextForSecrets(dense, { limit: -5 }).hits).toEqual([]);
	});

	it("keeps every hit when the text has fewer than the limit", () => {
		const text = `line one\n${SECRET_LINES[0]?.[1]}\nline three`;
		expect(scanTextForSecrets(text, { limit: 100 })).toEqual({
			hits: [{ rule: SECRET_LINES[0]?.[0], line: 2 }],
			total: 1,
		});
	});

	it("leaves the unbounded form's result unchanged", () => {
		expect(scanTextForSecrets(dense)).toHaveLength(DENSE_LINES);
	});
});

describe("isSecretFileName", () => {
	it.each([
		".env.example",
		"apps/web/.env.sample",
		".env.template",
		".env.dist",
	])(
		"exempts the committed env template %s (content rules still scan it)",
		(path) => {
			expect(isSecretFileName(path)).toBeNull();
		},
	);
	it("still rejects a real env file next to a template", () => {
		expect(isSecretFileName("apps/web/.env.local")).toBe("**/.env.*");
	});

	// M1 (round 2): the exemption is SUFFIX-based on purpose, so a
	// per-environment template is exempt while the environment file it
	// documents is not. Teams name these per environment as a matter of
	// course; matching only the bare `.env.example` would reject the
	// per-environment ones on their name alone. The exemption is from the NAME
	// gate only — the content rules still scan the file.
	it.each([
		[".env.production.example", null],
		[".env.production", "**/.env.*"],
		["apps/web/.env.staging.template", null],
		["apps/web/.env.staging", "**/.env.*"],
		[".env.credentials.dist", null],
		[".env.credentials", "**/.env.*"],
	] as const)("%s → %s", (path, expected) => {
		expect(isSecretFileName(path)).toBe(expected);
	});

	it("exempts a template from the NAME gate only — its content is still scanned", () => {
		// Assembled at runtime: gitleaks runs on the commit hook and on the OSS
		// relay with no test-path allowlist.
		const token = ["ghp_", "b".repeat(36)].join("");
		expect(isSecretFileName(".env.production.example")).toBeNull();
		expect(scanTextForSecrets(`GITHUB_TOKEN=${token}`)).toEqual([
			{ rule: "github-token", line: 1 },
		]);
	});
	it.each([
		[".env", "**/.env"],
		[".env.local", "**/.env.*"],
		[".env.production", "**/.env.*"],
		["apps/web/.env", "**/.env"],
		["certs/server.pem", "**/*.pem"],
		["deploy/private.KEY", "**/*.key"],
		["certs/bundle.p12", "**/*.p12"],
		["certs/bundle.pfx", "**/*.pfx"],
		["java/keystore.jks", "**/*.jks"],
		["vault/passwords.kdbx", "**/*.kdbx"],
		[".netrc", "**/.netrc"],
		[".npmrc", "**/.npmrc"],
		["nested/dir/.pypirc", "**/.pypirc"],
		[".ssh/id_rsa", "**/id_rsa"],
		[".ssh/id_dsa", "**/id_dsa"],
		[".ssh/id_ecdsa", "**/id_ecdsa"],
		[".ssh/id_ed25519", "**/id_ed25519"],
	] as const)("%s is rejected on its name by %s", (path, pattern) => {
		expect(isSecretFileName(path)).toBe(pattern);
	});

	it.each([
		"CLAUDE.md",
		".claude/skills/x/SKILL.md",
		"docs/environment.md",
		"scripts/keygen.sh",
		// The public half of a key pair is not a credential, and neither is a
		// file that merely mentions one in its name.
		".ssh/id_rsa.pub",
		"docs/npmrc-setup.md",
		"src/env.ts",
	])("%s is not name-rejected", (path) => {
		expect(isSecretFileName(path)).toBeNull();
	});

	it("returns the matched PATTERN, never the path, so the value is safe to persist", () => {
		const match = isSecretFileName("clients/acme-corp/.env.staging");
		expect(match).toBe("**/.env.*");
		expect(match).not.toContain("acme-corp");
	});
});
