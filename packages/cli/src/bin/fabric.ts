/**
 * @fabricorg/cli — fabric command
 *
 * Usage: fabric <command> [subcommand] [options]
 *
 * Exit codes:
 *   0  success
 *   1  general failure
 *   2  invalid usage / bad arguments
 *   3  auth failure
 *   4  not found
 *   5  forbidden
 *   6  rate limited
 *   7  validation error
 */

import { Command } from "commander";
import { buildAgentsCommand } from "../commands/agents/index.js";
import { buildKeysCommand } from "../commands/auth/keys.js";
import { buildLoginCommand } from "../commands/auth/login.js";
import { buildLogoutCommand } from "../commands/auth/logout.js";
import { buildWhoamiCommand } from "../commands/auth/whoami.js";
import { buildChatsCommand } from "../commands/chats/index.js";
import { buildCompletionCommand } from "../commands/completion/index.js";
import { buildCtxCommand } from "../commands/ctx/index.js";
import { buildFeaturesCommand } from "../commands/features/index.js";
import { buildFramesCommand } from "../commands/frames/index.js";
import { buildMcpCommand } from "../commands/mcp/index.js";
import { buildOrgsCommand } from "../commands/orgs/index.js";
import { buildProjectsCommand } from "../commands/projects/index.js";
import { buildPromptsCommand } from "../commands/prompts/index.js";
import { buildReportsCommand } from "../commands/reports/index.js";
import { buildSkillsCommand } from "../commands/skills/index.js";
import { buildWorkflowsCommand } from "../commands/workflows/index.js";
import { buildWorkspacesCommand } from "../commands/workspaces/index.js";
import { getConfigPath } from "../lib/config.js";

const program = new Command();

program
	.name("fabric")
	.description("Fabric AI platform CLI")
	.version("0.1.0")
	.option(
		"--format <format>",
		"Output format: table|json|yaml|csv",
		process.env.FABRIC_FORMAT ?? "table",
	);

// ---------------------------------------------------------------------------
// fabric auth
// ---------------------------------------------------------------------------
const auth = new Command("auth").description(
	"Authenticate and manage API keys",
);
auth.addCommand(buildLoginCommand());
auth.addCommand(buildLogoutCommand());
auth.addCommand(buildWhoamiCommand());
auth.addCommand(buildKeysCommand());
program.addCommand(auth);

// ---------------------------------------------------------------------------
// fabric ctx
// ---------------------------------------------------------------------------
program.addCommand(buildCtxCommand());

// ---------------------------------------------------------------------------
// fabric orgs
// ---------------------------------------------------------------------------
program.addCommand(buildOrgsCommand());

// ---------------------------------------------------------------------------
// fabric projects
// ---------------------------------------------------------------------------
program.addCommand(buildProjectsCommand());

// ---------------------------------------------------------------------------
// fabric features
// ---------------------------------------------------------------------------
program.addCommand(buildFeaturesCommand());

// ---------------------------------------------------------------------------
// fabric workflows
// ---------------------------------------------------------------------------
program.addCommand(buildWorkflowsCommand());

// ---------------------------------------------------------------------------
// fabric prompts
// ---------------------------------------------------------------------------
program.addCommand(buildPromptsCommand());

// ---------------------------------------------------------------------------
// fabric agents
// ---------------------------------------------------------------------------
program.addCommand(buildAgentsCommand());

// ---------------------------------------------------------------------------
// fabric skills
// ---------------------------------------------------------------------------
program.addCommand(buildSkillsCommand());

// ---------------------------------------------------------------------------
// fabric mcp
// ---------------------------------------------------------------------------
program.addCommand(buildMcpCommand());

// ---------------------------------------------------------------------------
// fabric frames
// ---------------------------------------------------------------------------
program.addCommand(buildFramesCommand());

// ---------------------------------------------------------------------------
// fabric workspaces
// ---------------------------------------------------------------------------
program.addCommand(buildWorkspacesCommand());

// ---------------------------------------------------------------------------
// fabric chats
// ---------------------------------------------------------------------------
program.addCommand(buildChatsCommand());

// ---------------------------------------------------------------------------
// fabric reports
// ---------------------------------------------------------------------------
program.addCommand(buildReportsCommand());

// ---------------------------------------------------------------------------
// fabric completion
// ---------------------------------------------------------------------------
program.addCommand(buildCompletionCommand());

// ---------------------------------------------------------------------------
// fabric config
// ---------------------------------------------------------------------------
const config = new Command("config").description("Show CLI configuration");
config
	.command("path")
	.description("Print the path to the config file")
	.action(() => {
		process.stdout.write(`${getConfigPath()}\n`);
	});
program.addCommand(config);

// ---------------------------------------------------------------------------
// Global error handler — structured JSON for --format json
// ---------------------------------------------------------------------------
process.on("unhandledRejection", (reason) => {
	const message = reason instanceof Error ? reason.message : String(reason);
	if (process.env.FABRIC_FORMAT === "json") {
		process.stderr.write(
			JSON.stringify({ error: { message, code: "UNHANDLED_ERROR" } }) +
				"\n",
		);
	} else {
		process.stderr.write(`✗ ${message}\n`);
	}
	process.exit(1);
});

program.parse(process.argv);
