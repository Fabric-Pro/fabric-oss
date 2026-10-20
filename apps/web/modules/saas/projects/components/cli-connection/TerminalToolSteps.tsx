"use client";

import {
	type CliDiscoveryDocument,
	tarballUrlOnOrigin,
} from "@saas/cli-distribution/lib/cli-discovery";
import type { LocalSetupRoute } from "../../lib/instructions-repository-sync";
import { CommandBlock } from "./CommandBlock";
import {
	buildClaudeCodeCommand,
	buildCloneAndInitLine,
	buildCodexCommand,
	buildInitLine,
	buildPluginInitLine,
	type CloneChoice,
	claudePluginInstallCommand,
	claudePluginMcpServerLabel,
	codexPluginAddCommand,
	type LocalSetupTool,
	pluginNameForProject,
} from "./lib/agent-sign-in";
import type { CheckoutSetup } from "./lib/checkout-setup";
import { REPOSITORY_STEP_TITLE, RepositoryChoice } from "./RepositoryChoice";
import { InlineCode, type SetupStep, StepList } from "./SetupSteps";

/* -------------------------------------------------------------------------- */
/* Copy                                                                        */
/* -------------------------------------------------------------------------- */

const RUN_STEP_TITLE = "Run this in your terminal";

const APPROVE_STEP_TITLE = "Approve in your browser";

const LOADING_NOTE = "Checking what this deployment serves…";

const NO_CLI_NOTE =
	"This deployment does not serve the Fabric CLI, so there is no one-line setup here. You can still connect over MCP:";

const NO_PROJECT_SOURCE_NOTE =
	"The one-line setup is not available for this project yet. You can still connect over MCP:";

const SETUP_LINE_LABEL = "Copy the setup line";

const UPLOAD_FOLDER_HINT = "Run it in the folder your agent works in.";

const NODE_REQUIREMENT = "Needs Node.js 22 or later.";

const CLAUDE_CODE_MCP_NEXT_STEP =
	"Then run /mcp in Claude Code and choose Authenticate. Your browser opens so you can approve the connection.";

const CODEX_MCP_NEXT_STEP =
	"The command opens your browser so you can approve the connection, and finishes once you have. Keep the terminal open until it does.";

const PLUGIN_NOTE =
	"After that, the instructions come from Fabric as a plugin at each session start, and files your agent writes in the project's memory folders reach the repository through Fabric.";

const CLAUDE_PLUGIN_STEP_TITLE = "Turn on the plugin in Claude Code";

const CODEX_PLUGIN_STEP_TITLE = "Turn on the plugin in Codex";

/* -------------------------------------------------------------------------- */
/* The setup line                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The setup line on the address the person is looking at. `--base-url` is
 * written unless the tarball is baked for exactly that address: it always wins
 * over the bake, so a tarball built for another address, or for none, is
 * harmless.
 */
function setupLineFor(args: {
	document: CliDiscoveryDocument;
	origin: string;
	tool: LocalSetupTool;
	route: LocalSetupRoute;
	projectId: string;
	choice: CloneChoice;
}): string {
	const { document, origin, tool, route, projectId, choice } = args;
	const line = {
		tarballUrl: tarballUrlOnOrigin(document, origin),
		baseUrl: document.origin === origin ? null : origin,
		tool,
		projectId,
	};
	if (route.kind === "repository" && choice === "clone") {
		return buildCloneAndInitLine(route, line);
	}
	if (route.kind === "repository" && choice === "have") {
		return buildInitLine(line);
	}
	return buildPluginInitLine(line);
}

/* -------------------------------------------------------------------------- */
/* Steps                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What the hook does once the person has approved, said as exactly as it is
 * true: a repository's branch is moved forward only when the checkout is clean,
 * and an upload project has nothing to move, so its hook only reports.
 */
function ApproveStep({
	tool,
	route,
	viaPlugin,
}: {
	tool: LocalSetupTool;
	route: LocalSetupRoute;
	viaPlugin: boolean;
}) {
	return (
		<>
			<p className="text-muted-foreground text-sm">
				A sign-in page opens.{" "}
				{viaPlugin || route.kind === "upload" ? (
					PLUGIN_NOTE
				) : (
					<>
						After that, at each session start a hook fast-forwards{" "}
						<InlineCode>{route.ref}</InlineCode> to the newest
						instructions when your checkout is clean, and says so
						when it cannot.
					</>
				)}
			</p>
			{tool === "codex" && !viaPlugin ? <CodexTrustNote /> : null}
		</>
	);
}

function CodexTrustNote() {
	return (
		<p className="text-muted-foreground text-sm">
			Then, in Codex, trust this folder when asked and run{" "}
			<InlineCode>/hooks</InlineCode> once to trust the project hook.
		</p>
	);
}

/**
 * The step after the sign-in on the plugin path. What it asks of the person
 * differs by tool: Claude Code wants its command accepted once in their own
 * terminal; Codex is installed by the setup itself.
 */
function PluginStep({
	tool,
	projectId,
	announce,
}: {
	tool: LocalSetupTool;
	projectId: string;
	announce: (message: string) => void;
}) {
	const name = pluginNameForProject(projectId);
	if (tool === "claude-code") {
		return (
			<>
				<p className="text-muted-foreground text-sm">
					The setup asks Claude Code to install this project's plugin,{" "}
					<InlineCode>{name}</InlineCode>, and you confirm it once in
					your own terminal, not from inside a coding session. If the
					setup printed the line instead, run it in the same folder:
				</p>
				<CommandBlock
					announce={announce}
					command={claudePluginInstallCommand(projectId)}
					label="Copy the plugin install command"
					testId="agent-sign-in-plugin-approval"
				/>
				<p className="text-muted-foreground text-sm">
					To let the agent use Fabric's tools, run{" "}
					<InlineCode>/mcp</InlineCode>, pick{" "}
					<InlineCode>
						{claudePluginMcpServerLabel(projectId)}
					</InlineCode>{" "}
					and choose Authenticate.
				</p>
			</>
		);
	}
	return (
		<>
			<p className="text-muted-foreground text-sm">
				The setup installs this project's plugin,{" "}
				<InlineCode>{name}</InlineCode>, in Codex. If it could not, run:
			</p>
			<CommandBlock
				announce={announce}
				command={codexPluginAddCommand(projectId)}
				label="Copy the Codex plugin command"
				testId="agent-sign-in-codex-plugin"
			/>
			<p className="text-muted-foreground text-xs">
				If your marketplace is not named{" "}
				<InlineCode>personal</InlineCode>, the setup prints the line
				with its name.
			</p>
			<CodexTrustNote />
		</>
	);
}

function checkoutSteps(args: {
	tool: LocalSetupTool;
	route: LocalSetupRoute;
	projectId: string;
	line: string;
	choice: CloneChoice;
	onChoiceChange: (choice: CloneChoice) => void;
	announce: (message: string) => void;
}): SetupStep[] {
	const { tool, route, projectId, line, choice, onChoiceChange, announce } =
		args;
	const viaPlugin = choice === "plugin" || route.kind === "upload";
	return [
		...(route.kind === "repository"
			? [
					{
						id: "repository",
						title: REPOSITORY_STEP_TITLE,
						children: (
							<RepositoryChoice
								choice={choice}
								onChoiceChange={onChoiceChange}
								route={route}
							/>
						),
					},
				]
			: []),
		{
			id: "run",
			title: RUN_STEP_TITLE,
			children: (
				<>
					{route.kind === "upload" ? (
						<p className="text-muted-foreground text-sm">
							{UPLOAD_FOLDER_HINT}
						</p>
					) : null}
					<CommandBlock
						announce={announce}
						command={line}
						label={SETUP_LINE_LABEL}
						testId="agent-sign-in-setup-line"
					/>
					<p className="text-muted-foreground text-xs">
						{NODE_REQUIREMENT}
					</p>
				</>
			),
		},
		{
			id: "approve",
			title: APPROVE_STEP_TITLE,
			approve: true,
			children: (
				<ApproveStep route={route} tool={tool} viaPlugin={viaPlugin} />
			),
		},
		...(viaPlugin
			? [
					{
						id: "plugin",
						title:
							tool === "claude-code"
								? CLAUDE_PLUGIN_STEP_TITLE
								: CODEX_PLUGIN_STEP_TITLE,
						children: (
							<PluginStep
								announce={announce}
								projectId={projectId}
								tool={tool}
							/>
						),
					},
				]
			: []),
	];
}

/**
 * Claude Code and Codex over MCP: today's route for the project purpose, and
 * the fallback when no one-line setup can be shown.
 */
function McpTerminalSteps({
	tool,
	origin,
	projectId,
	announce,
}: {
	tool: LocalSetupTool;
	origin: string;
	projectId: string;
	announce: (message: string) => void;
}) {
	const command =
		tool === "claude-code"
			? buildClaudeCodeCommand(origin, projectId)
			: buildCodexCommand(origin, projectId);
	const steps: SetupStep[] = [
		{
			id: "run",
			title: RUN_STEP_TITLE,
			children: (
				<CommandBlock
					announce={announce}
					command={command}
					label={
						tool === "claude-code"
							? "Copy the Claude Code command"
							: "Copy the Codex command"
					}
					testId={`agent-sign-in-${tool}`}
				/>
			),
		},
		{
			id: "approve",
			title: APPROVE_STEP_TITLE,
			approve: true,
			children: (
				<p className="text-muted-foreground text-sm">
					{tool === "claude-code"
						? CLAUDE_CODE_MCP_NEXT_STEP
						: CODEX_MCP_NEXT_STEP}
				</p>
			),
		},
	];
	return <StepList steps={steps} />;
}

/**
 * Claude Code and Codex: the one line for a repository project's checkout or
 * the folder an upload project's agent works in, or MCP when this deployment
 * or project has no such line.
 */
export function TerminalToolSteps({
	tool,
	origin,
	projectId,
	checkout,
	cloneChoice,
	onCloneChoiceChange,
	announce,
}: {
	tool: LocalSetupTool;
	origin: string;
	projectId: string;
	checkout?: CheckoutSetup;
	cloneChoice: CloneChoice;
	onCloneChoiceChange: (choice: CloneChoice) => void;
	announce: (message: string) => void;
}) {
	if (!checkout) {
		return (
			<McpTerminalSteps
				announce={announce}
				origin={origin}
				projectId={projectId}
				tool={tool}
			/>
		);
	}

	const { discovery, localSetup } = checkout;

	// The page's own address is empty until the dialog has mounted, and the
	// line is written against it.
	if (discovery.status === "loading" || origin === "") {
		return (
			<output className="block text-muted-foreground text-sm">
				{LOADING_NOTE}
			</output>
		);
	}

	if (discovery.status === "unavailable" || localSetup === null) {
		return (
			<div className="space-y-4">
				<p
					className="text-muted-foreground text-sm"
					data-testid="agent-sign-in-line-unavailable"
				>
					{discovery.status === "unavailable"
						? NO_CLI_NOTE
						: NO_PROJECT_SOURCE_NOTE}
				</p>
				<McpTerminalSteps
					announce={announce}
					origin={origin}
					projectId={projectId}
					tool={tool}
				/>
			</div>
		);
	}

	return (
		<StepList
			steps={checkoutSteps({
				tool,
				route: localSetup,
				projectId,
				line: setupLineFor({
					document: discovery.document,
					origin,
					tool,
					route: localSetup,
					projectId,
					choice: cloneChoice,
				}),
				choice: cloneChoice,
				onChoiceChange: onCloneChoiceChange,
				announce,
			})}
		/>
	);
}
