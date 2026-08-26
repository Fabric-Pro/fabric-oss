import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runHook } from "./_helpers.mjs";

const HOOK = "block-shared-env-sql-writes.mjs";

async function bash(command) {
	return runHook(HOOK, { tool_name: "Bash", tool_input: { command } });
}

describe("block-shared-env-sql-writes — blocks (shared + write)", () => {
	const blocked = [
		`psql "postgresql://u:p@ep-x.neon.tech/db" -c "DELETE FROM users WHERE id=1"`,
		`psql -h staging-db.example.com -c "INSERT INTO users (id) VALUES (1)"`,
		`psql -h prod-db -c "ALTER TABLE users ADD COLUMN extra TEXT"`,
		`PGHOST=foo.neon.tech psql -c "UPDATE users SET email='x' WHERE id=1"`,
		`psql -h production-replica -c "CREATE INDEX foo ON users (id)"`,
		`psql -h staging -c "GRANT SELECT ON users TO foo"`,
	];
	for (const command of blocked) {
		it(`blocks: ${command}`, async () => {
			const result = await bash(command);
			assert.equal(result.exitCode, 2, `stderr: ${result.stderr}`);
			assert.match(result.stderr, /shared environment/);
		});
	}
});

describe("block-shared-env-sql-writes — allows (shared + read)", () => {
	const allowed = [
		`psql "postgresql://u:p@ep-x.neon.tech/db" -c "SELECT * FROM users LIMIT 1"`,
		`psql -h staging-db -c "EXPLAIN SELECT * FROM users"`,
		`psql -h prod -c "\\dt"`,
		`psql -h production -c "SHOW server_version"`,
		`psql -h staging -c "WITH x AS (SELECT 1) SELECT * FROM x"`,
	];
	for (const command of allowed) {
		it(`allows (shared+read): ${command}`, async () => {
			const result = await bash(command);
			assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
		});
	}
});

describe("block-shared-env-sql-writes — allows (local)", () => {
	const allowed = [
		`psql -h localhost -c "DELETE FROM users"`,
		`psql -h 127.0.0.1 -c "TRUNCATE foo"`,
		`psql -h host.docker.internal -c "INSERT INTO x VALUES (1)"`,
		`psql -c "DELETE FROM users"`, // no host = local default
		"psql -h staging-db -f mig.sql", // -f not inspected (documented limitation)
		`psql -h prod -c "SELECT 1"`, // shared+read
	];
	for (const command of allowed) {
		it(`allows (local-or-unsupported): ${command}`, async () => {
			const result = await bash(command);
			assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
		});
	}
});

describe("block-shared-env-sql-writes — non-Bash and non-psql", () => {
	it("does nothing when tool_name is not Bash", async () => {
		const result = await runHook(HOOK, {
			tool_name: "Edit",
			tool_input: { file_path: "/tmp/x" },
		});
		assert.equal(result.exitCode, 0);
	});

	it("does nothing when the command does not invoke psql", async () => {
		const result = await bash("echo hello world");
		assert.equal(result.exitCode, 0);
	});
});
