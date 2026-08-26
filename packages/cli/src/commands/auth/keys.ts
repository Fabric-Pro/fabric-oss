/**
 * fabric auth keys
 *
 *   fabric auth keys list
 *   fabric auth keys create --name "CI deploy" --scopes workflows:run,agents:read
 *   fabric auth keys revoke <id>
 */

import { Command } from "commander";
import { getClient } from "../../lib/client.js";
import { printError, printOutput, printSuccess } from "../../lib/output.js";

export function buildKeysCommand(): Command {
	const keys = new Command("keys").description("Manage API keys");

	// -- list ----------------------------------------------------------------
	keys.command("list")
		.description("List your API keys")
		.option(
			"--format <format>",
			"Output format: table|json|yaml|csv",
			"table",
		)
		.action(async (opts: { format: string }) => {
			const client = getClient();
			let list: Awaited<ReturnType<typeof client.auth.listKeys>>;
			try {
				list = await client.auth.listKeys();
			} catch (err: unknown) {
				printError((err as Error).message, 1);
			}
			printOutput(list, {
				format: opts.format as "table" | "json" | "yaml" | "csv",
				columns: [
					"id",
					"name",
					"keyPrefix",
					"scopes",
					"lastUsedAt",
					"expiresAt",
					"createdAt",
				],
			});
		});

	// -- create --------------------------------------------------------------
	keys.command("create")
		.description("Create a new API key (raw key shown only once)")
		.requiredOption("-n, --name <name>", "Key name")
		.option(
			"-s, --scopes <scopes>",
			"Comma-separated scopes (e.g. projects:read,workflows:run)",
			"orgs:read",
		)
		.option(
			"-e, --expires <days>",
			"Days until expiry (1–365, omit for no expiry)",
		)
		.option("--format <format>", "Output format: table|json|yaml", "table")
		.action(
			async (opts: {
				name: string;
				scopes: string;
				expires?: string;
				format: string;
			}) => {
				const client = getClient();
				const scopes = opts.scopes.split(",").map((s) => s.trim());
				const expiresInDays = opts.expires
					? Number.parseInt(opts.expires, 10)
					: undefined;

				if (
					expiresInDays !== undefined &&
					Number.isNaN(expiresInDays)
				) {
					printError("--expires must be a number", 2);
				}

				let created: Awaited<ReturnType<typeof client.auth.createKey>>;
				try {
					created = await client.auth.createKey({
						name: opts.name,
						scopes,
						expiresInDays,
					});
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				const fmt = opts.format as "table" | "json" | "yaml";

				if (fmt === "json" || fmt === "yaml") {
					printOutput(created, { format: fmt });
					return;
				}

				process.stdout.write("\n");
				printSuccess(`API key created: ${created.name}`);
				process.stdout.write(`\n  Key:     ${created.rawKey}\n`);
				process.stdout.write(`  Prefix:  ${created.keyPrefix}\n`);
				process.stdout.write(
					`  Scopes:  ${created.scopes.join(", ")}\n`,
				);
				if (created.expiresAt) {
					process.stdout.write(
						`  Expires: ${String(created.expiresAt).slice(0, 10)}\n`,
					);
				}
				process.stdout.write(
					"\n  ⚠  Store this key now — it will never be shown again.\n\n",
				);
			},
		);

	// -- revoke --------------------------------------------------------------
	keys.command("revoke <id>")
		.description("Permanently revoke an API key")
		.action(async (id: string) => {
			const client = getClient();
			try {
				await client.auth.revokeKey(id);
			} catch (err: unknown) {
				printError((err as Error).message, 1);
			}
			printSuccess(`API key ${id} revoked.`);
		});

	return keys;
}
