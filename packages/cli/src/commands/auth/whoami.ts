/**
 * fabric auth whoami
 * Prints the authenticated identity and org memberships.
 *
 *   fabric auth whoami                          the deployment this run talks to
 *   fabric auth whoami --base-url <url>         another deployment you are signed in to
 *   fabric auth whoami --project <id>           who a project's sign-in is
 */

import { Command } from "commander";
import { getClient } from "../../lib/client.js";
import { isProjectId } from "../../lib/oauth/project-resource.js";
import { BAD_BASE_URL_LINE, normalizeOrigin } from "../../lib/origin.js";
import { printError, printOutput, printRecord } from "../../lib/output.js";

export function buildWhoamiCommand(): Command {
	return new Command("whoami")
		.description("Show current authentication and identity")
		.option("--format <format>", "Output format: table|json|yaml", "table")
		.option(
			"--base-url <url>",
			"Deployment to ask, such as https://example.com (default: the one you are signed in to)",
		)
		.option(
			"--project <id>",
			"Ask with this project's own sign-in, if it has one",
		)
		.action(
			async (opts: {
				format: string;
				baseUrl?: string;
				project?: string;
			}) => {
				const origin =
					opts.baseUrl === undefined
						? undefined
						: normalizeOrigin(opts.baseUrl);
				if (opts.baseUrl !== undefined && origin === null) {
					printError(BAD_BASE_URL_LINE, 2);
				}
				if (opts.project !== undefined && !isProjectId(opts.project)) {
					printError(
						"--project must be a project id: letters, digits, '_' and '-', at most 64.",
						2,
					);
				}
				const client = getClient({
					...(origin === undefined || origin === null
						? {}
						: { baseUrl: origin }),
					...(opts.project === undefined
						? {}
						: { project: opts.project }),
				});

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
					...(me.projectContext === undefined
						? {}
						: { Project: me.projectContext }),
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
			},
		);
}
