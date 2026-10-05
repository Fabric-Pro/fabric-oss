"use client";

import { Tabs, TabsContent } from "@ui/components/tabs";
import { useState } from "react";
import { EditorToolSteps } from "./EditorToolSteps";
import type { CloneChoice } from "./lib/agent-sign-in";
import { type AgentId, isAgentId } from "./lib/agent-tools";
import type { CheckoutSetup } from "./lib/checkout-setup";
import { PortableToolSteps } from "./PortableToolSteps";
import { TerminalToolSteps } from "./TerminalToolSteps";
import { ToolPicker } from "./ToolPicker";

interface AgentSignInSectionProps {
	/** The deployment origin the entries point at. Empty until mounted. */
	origin: string;
	/**
	 * The project every entry connects to, by its gateway URL: the sign-in is
	 * for this project alone and asks for no organization or project.
	 */
	projectId: string;
	/** Names an editor's server, so two projects' servers do not collide. */
	projectName: string;
	/**
	 * Says a copy's outcome through the host's live region. The dialog keeps
	 * exactly one, so this section adds none of its own.
	 */
	announce: (message: string) => void;
	/**
	 * Set for the coding-instructions purpose. Without it, Claude Code and
	 * Codex connect over MCP only, which is all the project purpose needs.
	 */
	checkout?: CheckoutSetup;
}

/**
 * The way to connect a coding tool: pick one, then follow its steps. No key.
 *
 * Claude Code and Codex run the CLI this deployment serves (coding
 * instructions) or add the gateway as an MCP server (project context); VS Code
 * and Cursor install the gateway from a link; any other client gets the
 * server entry. Whichever it is, the tool signs in through the browser and the
 * person approves it once. See `./lib/agent-sign-in.ts` for where each format
 * comes from.
 *
 * The picked tool and the clone choice live here, above the steps, so the
 * choice survives a change of tool and the "Other" steps can send the person
 * to the Claude Code ones.
 */
export function AgentSignInSection({
	origin,
	projectId,
	projectName,
	announce,
	checkout,
}: AgentSignInSectionProps) {
	const [tool, setTool] = useState<AgentId>("claude-code");
	const [cloneChoice, setCloneChoice] = useState<CloneChoice>("have");

	const oneLineSetupExists =
		checkout?.discovery.status === "ready" && checkout.localSetup !== null;
	const afterward =
		checkout === undefined
			? null
			: checkout.localSetup?.kind === "repository"
				? "repository"
				: "upload";

	const stepsFor = (picked: AgentId) => {
		switch (picked) {
			case "claude-code":
			case "codex":
				return (
					<TerminalToolSteps
						announce={announce}
						checkout={checkout}
						cloneChoice={cloneChoice}
						onCloneChoiceChange={setCloneChoice}
						origin={origin}
						projectId={projectId}
						tool={picked}
					/>
				);
			case "vscode":
			case "cursor":
				return (
					<EditorToolSteps
						afterward={afterward}
						editor={picked}
						origin={origin}
						projectId={projectId}
						projectName={projectName}
					/>
				);
			case "other":
				return (
					<PortableToolSteps
						announce={announce}
						onUseOneLineSetup={
							oneLineSetupExists
								? () => setTool("claude-code")
								: null
						}
						origin={origin}
						projectId={projectId}
					/>
				);
			default: {
				const unreachable: never = picked;
				return unreachable;
			}
		}
	};

	return (
		<section data-testid="agent-sign-in">
			<Tabs
				onValueChange={(value) => {
					if (isAgentId(value)) {
						setTool(value);
					}
				}}
				value={tool}
			>
				<ToolPicker />
				{/* Keyed by tool, so a "Copied" on one tool's block never shows
				 * on the next tool's. */}
				<TabsContent className="mt-6" key={tool} value={tool}>
					{stepsFor(tool)}
				</TabsContent>
			</Tabs>
		</section>
	);
}
