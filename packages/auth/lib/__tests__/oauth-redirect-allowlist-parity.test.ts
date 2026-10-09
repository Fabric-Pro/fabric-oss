import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PRE_RFC8252_NATIVE_REDIRECT_URIS } from "../oauth-registration-policy";

const packages = resolve(import.meta.dirname, "../../..");
const repository = resolve(packages, "..");
const migrationPath = resolve(
	packages,
	"database/prisma/migrations/20261007120000_allow_cursor_oauth_callback/migration.sql",
);
const installerPath = resolve(
	packages,
	"database/scripts/backfill-better-auth-1-7.sql",
);

function patchPath(): string {
	const patches = resolve(repository, "patches");
	const found = readdirSync(patches).filter((name) =>
		/^@better-auth__oauth-provider@.+\.patch$/.test(name),
	);
	expect(found).toHaveLength(1);
	return resolve(patches, found[0] as string);
}

/** The exact callbacks a trigger function compares `redirect_uri` against. */
function sqlUris(file: string): string[] {
	const source = readFileSync(file, "utf8");
	const chain = source.match(
		/private_redirect := ((?:redirect_uri = '[^']*'\s+OR\s+)+)/,
	);
	expect(chain, `${file} has no exact-callback chain`).not.toBeNull();
	return [...(chain?.[1] ?? "").matchAll(/redirect_uri = '([^']*)'/g)].map(
		(match) => match[1] as string,
	);
}

function patchUris(): string[] {
	const source = readFileSync(patchPath(), "utf8");
	const set = source.match(
		/PRE_RFC8252_NATIVE_REDIRECT_URIS = new Set\(\[([^\]]*)\]\)/,
	);
	expect(set, "the patch has no allowlist Set").not.toBeNull();
	return [...(set?.[1] ?? "").matchAll(/"([^"]*)"/g)].map(
		(match) => match[1] as string,
	);
}

describe("the pre-RFC 8252 native callback allowlist", () => {
	const policy = [...PRE_RFC8252_NATIVE_REDIRECT_URIS].sort();

	it("lists at least one callback", () => {
		expect(policy.length).toBeGreaterThan(0);
	});

	it.each([
		["the oauth-provider patch", patchUris],
		["the migration's client trigger", () => sqlUris(migrationPath)],
		["the installer's client trigger", () => sqlUris(installerPath)],
	])("is the same in the policy and %s", (_name, read) => {
		expect(read().sort()).toEqual(policy);
	});
});
