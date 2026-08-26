#!/usr/bin/env node
import { writeBlockMessage } from "./lib/block-message.mjs";
import { readToolInput } from "./lib/parse-input.mjs";

/**
 * Matches `prisma db push` anywhere in the command, including via
 * `npx`, `pnpm exec`, `pnpm prisma`, `yarn dlx`, or `bash -c "..."`.
 * Whitespace between the three tokens may be a literal space, tab,
 * or — when wrapped — quoted whitespace.
 */
const PATTERN = /\bprisma\s+db\s+push\b/;

function main() {
	let toolCall;
	try {
		toolCall = readToolInput();
	} catch (err) {
		process.stderr.write(`block-prisma-db-push: ${err.message}\n`);
		process.exit(0);
	}

	if (toolCall.tool_name !== "Bash") {
		process.exit(0);
	}
	const command = String(toolCall.tool_input?.command ?? "");
	if (!command) {
		process.exit(0);
	}

	if (!PATTERN.test(command)) {
		process.exit(0);
	}

	writeBlockMessage({
		command,
		reason: "`prisma db push` bypasses migration history — use `prisma migrate dev`",
		sourceRef: "CONTRIBUTING.md:69",
		proceedHint:
			"run `npx prisma migrate dev --name <migration_name> --schema=./prisma/schema.prisma`, " +
			'or set "disableAllHooks": true in .claude/settings.local.json',
	});
	process.exit(2);
}

main();
