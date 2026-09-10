import assert from "node:assert/strict";
import { mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	MAX_CLAUDE_BYTES,
	MAX_ROOT_BYTES,
	validateGuidance,
} from "./check.mjs";

const requiredPolicy = `# Repository guidance

## Tenancy and authorization

An organization is the only tenant context.

## Database safety

Never run \`prisma db push\`.

## Public repository hygiene

This public repository must contain only synthetic identifiers.

## Changesets and delivery

Every PR must choose exactly one: a non-empty changeset or the \`skip-changeset\` label.
Every commit requires DCO sign-off through \`git commit -s\`.
`;

const rootClaudeImport = "@AGENTS.md";

async function makeRepository(agents = requiredPolicy) {
	const root = await mkdtemp(join(tmpdir(), "agent-guidance-test-"));
	await writeFile(join(root, "AGENTS.md"), agents);
	await writeFile(
		join(root, "CLAUDE.md"),
		`# Claude\n\n${rootClaudeImport}\n`,
	);
	await writeFile(join(root, "CONTRIBUTING.md"), "# Contributing\n");
	await mkdir(join(root, ".github"));
	await writeFile(
		join(root, ".github/PULL_REQUEST_TEMPLATE.md"),
		"# Pull request\n\n## Local smoke test\n\nOnly when automated tests genuinely cannot cover the behavior.\n",
	);
	await mkdir(join(root, ".github/workflows"));
	await writeFile(
		join(root, ".github/workflows/changeset-check.yml"),
		"if: ${{ !(vars.RELEASE_APP_LOGIN != '' && github.event.pull_request.user.login == vars.RELEASE_APP_LOGIN && github.event.pull_request.head.repo.full_name == github.repository && github.event.pull_request.head.ref == 'changeset-release/master') }}\n",
	);
	for (const path of [
		"apps/web/AGENTS.md",
		"packages/api/AGENTS.md",
		"packages/database/AGENTS.md",
		"packages/temporal/AGENTS.md",
	]) {
		await mkdir(join(root, path, ".."), { recursive: true });
		await writeFile(join(root, path), "# Scoped guidance\n");
		await writeFile(
			join(root, path.replace("AGENTS.md", "CLAUDE.md")),
			"@AGENTS.md\n",
		);
	}
	return root;
}

test("accepts compact guidance with valid repository-relative links", async () => {
	const root = await makeRepository(
		`${requiredPolicy}\nRead [the policy](docs/policy.md).\n`,
	);
	await mkdir(join(root, "docs"));
	await writeFile(join(root, "docs/policy.md"), "# Policy\n");

	assert.deepEqual(await validateGuidance(root), []);
});

test("rejects root guidance that exceeds the reserved byte budget", async () => {
	const padding = "x".repeat(MAX_ROOT_BYTES);
	const root = await makeRepository(`${requiredPolicy}\n${padding}`);

	const errors = await validateGuidance(root);

	assert.ok(errors.some((error) => error.includes("exceeds 20480 bytes")));
});

test("rejects removal of a critical root policy", async () => {
	const root = await makeRepository(
		requiredPolicy.replace("skip-changeset", "skip release notes"),
	);

	const errors = await validateGuidance(root);

	assert.ok(
		errors.some((error) => error.includes("changeset-or-skip decision")),
	);
});

test("rejects broken repository-relative links in root instructions", async () => {
	const root = await makeRepository(
		`${requiredPolicy}\nRead [missing guidance](docs/missing.md).\n`,
	);

	const errors = await validateGuidance(root);

	assert.ok(errors.some((error) => error.includes("docs/missing.md")));
});

test("rejects broken links in nested agent guidance", async () => {
	const root = await makeRepository();
	await writeFile(
		join(root, "packages/api/AGENTS.md"),
		"# API\n\nRead [local policy](../../docs/missing.md).\n",
	);

	const errors = await validateGuidance(root);

	assert.ok(
		errors.some(
			(error) =>
				error.includes("packages/api/AGENTS.md") &&
				error.includes("docs/missing.md"),
		),
	);
});

test("rejects removal of required nested guidance", async () => {
	const root = await makeRepository();
	await unlink(join(root, "packages/api/AGENTS.md"));

	const errors = await validateGuidance(root);

	assert.ok(
		errors.some(
			(error) =>
				error.includes("packages/api/AGENTS.md") &&
				error.includes("missing"),
		),
	);
});

test("rejects a missing Claude shim for nested agent guidance", async () => {
	const root = await makeRepository();
	await unlink(join(root, "packages/api/CLAUDE.md"));

	const errors = await validateGuidance(root);

	assert.ok(
		errors.some(
			(error) =>
				error.includes("packages/api/CLAUDE.md") &&
				error.includes("missing"),
		),
	);
});

test("rejects a nested Claude shim that omits its local AGENTS import", async () => {
	const root = await makeRepository();
	await writeFile(
		join(root, "packages/api/CLAUDE.md"),
		"# Independent API guidance\n",
	);

	const errors = await validateGuidance(root);

	assert.ok(
		errors.some(
			(error) =>
				error.includes("packages/api/CLAUDE.md") &&
				error.includes("local AGENTS.md"),
		),
	);
});

test("rejects an empty nested Claude shim", async () => {
	const root = await makeRepository();
	await writeFile(join(root, "packages/api/CLAUDE.md"), "");

	const errors = await validateGuidance(root);

	assert.ok(
		errors.some(
			(error) =>
				error.includes("packages/api/CLAUDE.md") &&
				error.includes("local AGENTS.md"),
		),
	);
});

test("rejects extra policy in a nested Claude import shim", async () => {
	const root = await makeRepository();
	await writeFile(
		join(root, "packages/api/CLAUDE.md"),
		"@AGENTS.md\n\nUse an independent API policy.\n",
	);

	const errors = await validateGuidance(root);

	assert.ok(
		errors.some(
			(error) =>
				error.includes("packages/api/CLAUDE.md") &&
				error.includes("import-only"),
		),
	);
});

test("rejects policy keywords used only in semantic reversals", async () => {
	const root = await makeRepository(`
# Repository guidance

An organization is the only tenant context is obsolete.
Do not block prisma db push.
Public identifiers do not need to be synthetic.
Changesets and skip-changeset are forbidden.
Signed-off-by is forbidden.
`);

	const errors = await validateGuidance(root);

	assert.ok(
		errors.some((error) => error.includes("organization-only tenancy")),
	);
	assert.ok(
		errors.some((error) => error.includes("Prisma migration safety")),
	);
	assert.ok(
		errors.some((error) => error.includes("public identifier hygiene")),
	);
	assert.ok(
		errors.some((error) => error.includes("changeset-or-skip decision")),
	);
	assert.ok(errors.some((error) => error.includes("DCO sign-off")));
});

test("rejects a Claude file that stops delegating to canonical guidance", async () => {
	const root = await makeRepository();
	await writeFile(join(root, "CLAUDE.md"), "# Independent Claude handbook\n");

	const errors = await validateGuidance(root);

	assert.ok(errors.some((error) => error.includes("canonical AGENTS.md")));
});

test("rejects a root Claude file with only a Markdown link to AGENTS", async () => {
	const root = await makeRepository();
	await writeFile(
		join(root, "CLAUDE.md"),
		"# Claude\n\nRead [AGENTS.md](AGENTS.md).\n",
	);

	const errors = await validateGuidance(root);

	assert.ok(errors.some((error) => error.includes("canonical AGENTS.md")));
});

test("rejects a root AGENTS import shown only inside a fenced example", async () => {
	const root = await makeRepository();
	await writeFile(
		join(root, "CLAUDE.md"),
		`# Claude\n\n~~~text\n${rootClaudeImport}\n~~~\n`,
	);

	const errors = await validateGuidance(root);

	assert.ok(errors.some((error) => error.includes("canonical AGENTS.md")));
});

test("rejects a Claude shim that grows beyond its compatibility budget", async () => {
	const root = await makeRepository();
	await writeFile(
		join(root, "CLAUDE.md"),
		`# Claude\n\n${rootClaudeImport}\n${"x".repeat(MAX_CLAUDE_BYTES)}`,
	);

	const errors = await validateGuidance(root);

	assert.ok(
		errors.some(
			(error) => error.includes("CLAUDE.md") && error.includes("exceeds"),
		),
	);
});

test("rejects obsolete personal-and-organization feature mandates", async () => {
	const root = await makeRepository();
	await writeFile(
		join(root, "CONTRIBUTING.md"),
		"Every feature must support both personal and organization contexts.\n",
	);

	const errors = await validateGuidance(root);

	assert.ok(
		errors.some((error) => error.includes("obsolete dual-context mandate")),
	);
});

test("rejects obsolete dual-context mandates split across lines", async () => {
	const root = await makeRepository();
	await writeFile(
		join(root, "CONTRIBUTING.md"),
		"Every feature\nmust support both\npersonal and organization contexts.\n",
	);

	const errors = await validateGuidance(root);

	assert.ok(
		errors.some((error) => error.includes("obsolete dual-context mandate")),
	);
});

test("rejects removal of the local smoke-test prompt", async () => {
	const root = await makeRepository();
	await writeFile(
		join(root, ".github/PULL_REQUEST_TEMPLATE.md"),
		"# Pull request\n\n## Testing\n",
	);

	const errors = await validateGuidance(root);

	assert.ok(
		errors.some((error) =>
			error.includes("conditional local smoke-test section"),
		),
	);
});

test("rejects a branch-name-only release PR exemption", async () => {
	const root = await makeRepository();
	await writeFile(
		join(root, ".github/workflows/changeset-check.yml"),
		"if: github.event.pull_request.head.ref != 'changeset-release/master'\n",
	);

	const errors = await validateGuidance(root);

	assert.ok(
		errors.some((error) => error.includes("trusted release PR exemption")),
	);
});
