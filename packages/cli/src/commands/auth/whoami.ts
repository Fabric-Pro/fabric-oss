/**
 * fabric auth whoami
 * Prints the authenticated identity and org memberships.
 */

import { Command } from "commander";
import { getClient } from "../../lib/client.js";
import { printError, printOutput, printRecord } from "../../lib/output.js";

export function buildWhoamiCommand(): Command {
	return new Command("whoami")
		.description("Show current authentication and identity")
		.option("--format <format>", "Output format: table|json|yaml", "table")
		.action(async (opts: { format: string }) => {
			const client = getClient();

			let me: Awaited<ReturnType<typeof client.auth.whoami>>;
			try {
				me = await client.auth.whoami();
			} catch (err: unknown) {
				printError((err as Error).message ?? "Request failed", 3);
			}

			const fmt = opts.format as "table" | "json" | "yaml";

			if (fmt === "json" || fmt === "yaml") {
				printOutput(me, { format: fmt });
				return;
			}

			// Human-readable
			printRecord({
				User: me.user.name ?? "(no name)",
				Email: me.user.email,
				Role: me.user.role,
				"Key type": me.keyType,
				"Key prefix": me.keyPrefix,
				Scopes: me.scopes.join(", "),
				"Orgs count": String(me.orgs.length),
				"Member since": me.user.createdAt.slice(0, 10),
			});

			if (me.orgs.length > 0) {
				process.stdout.write("\nOrganizations:\n");
				printOutput(me.orgs, {
					format: "table",
					columns: ["name", "slug", "role", "joinedAt"],
				});
			}
		});
}
