import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runHook } from "./_helpers.mjs";

const HOOK = "block-prisma-db-push.mjs";

async function bash(command) {
	return runHook(HOOK, { tool_name: "Bash", tool_input: { command } });
}

describe("block-prisma-db-push — blocks", () => {
	const blocked = [
		"npx prisma db push",
		"pnpm exec prisma db push --schema=./prisma/schema.prisma",
		"pnpm prisma db push",
		"yarn dlx prisma db push",
		'bash -c "npx prisma db push"',
		"cd packages/database && npx prisma db push",
	];
	for (const command of blocked) {
		it(`blocks: ${command}`, async () => {
			const result = await bash(command);
			assert.equal(result.exitCode, 2, `stderr: ${result.stderr}`);
			assert.match(result.stderr, /prisma migrate dev/);
			assert.match(result.stderr, /CONTRIBUTING\.md:69/);
		});
	}
});

describe("block-prisma-db-push — allows", () => {
	const allowed = [
		"npx prisma migrate dev --name add_table",
		"npx prisma migrate deploy",
		"npx prisma migrate reset",
		"npx prisma migrate resolve --applied 20240101_init",
		"pnpm prisma generate",
		"npx prisma db pull",
		"npx prisma db seed",
		"npx prisma db execute --file ./script.sql",
		"npx prisma studio",
		"npx prisma format",
		"pnpm install",
		"echo 'prisma db push is bad'", // mentions phrase in non-prisma context
	];
	for (const command of allowed) {
		it(`allows: ${command}`, async () => {
			const result = await bash(command);
			// The single false positive in the list above (echo with the literal
			// phrase) is intentional — the spec says match any command that
			// "contains `prisma db push`". We document it here so the boundary
			// is recorded; if it ever becomes a real-world hit, tighten the
			// pattern to require a leading word boundary like /\bnpx\b|\bpnpm\b/.
			if (command.startsWith("echo")) {
				assert.equal(result.exitCode, 2);
			} else {
				assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
			}
		});
	}
});

describe("block-prisma-db-push — non-Bash", () => {
	it("does nothing when tool_name is not Bash", async () => {
		const result = await runHook(HOOK, {
			tool_name: "Edit",
			tool_input: { file_path: "/tmp/x" },
		});
		assert.equal(result.exitCode, 0);
	});
});
