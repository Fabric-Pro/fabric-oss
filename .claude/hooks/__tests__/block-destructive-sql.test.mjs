import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runHook } from "./_helpers.mjs";

const HOOK = "block-destructive-sql.mjs";

async function bash(command) {
	return runHook(HOOK, { tool_name: "Bash", tool_input: { command } });
}

describe("block-destructive-sql — blocks (always-on, environment-agnostic)", () => {
	const blocked = [
		'psql -c "DROP TABLE users"',
		'psql -c "DROP DATABASE fabric"',
		'psql -c "TRUNCATE users"',
		'psql -c "DELETE FROM users"',
		`psql -c "UPDATE users SET email='x'"`,
		'psql -c "delete from users"', // case-insensitive
		'psql -c "Drop Table Users"',
		'psql -h localhost -c "DELETE FROM users"', // local does not exempt
		'psql --command="TRUNCATE foo"',
		'psql -h prod-db -c "DROP TABLE x"',
	];
	for (const command of blocked) {
		it(`blocks: ${command}`, async () => {
			const result = await bash(command);
			assert.equal(result.exitCode, 2, `stderr: ${result.stderr}`);
			assert.match(result.stderr, /^Blocked: /m);
		});
	}
});

describe("block-destructive-sql — allows", () => {
	const allowed = [
		'psql -c "SELECT * FROM users"',
		'psql -c "DELETE FROM users WHERE id=1"',
		`psql -c "UPDATE users SET email='x' WHERE id=1"`,
		'psql -c "\\dt"',
		"psql -f migration.sql", // -f files are not inspected (documented limitation)
		"psql -h localhost",
		"echo SELECT", // no psql token
	];
	for (const command of allowed) {
		it(`allows: ${command}`, async () => {
			const result = await bash(command);
			assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
		});
	}
});

describe("block-destructive-sql — non-Bash", () => {
	it("does nothing when tool_name is not Bash", async () => {
		const result = await runHook(HOOK, {
			tool_name: "Edit",
			tool_input: { file_path: "/tmp/x" },
		});
		assert.equal(result.exitCode, 0);
	});
});
