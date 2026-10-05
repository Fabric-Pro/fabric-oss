"use client";

import { Button } from "@ui/components/button";
import { ExternalLinkIcon } from "lucide-react";
import { AgentLogo } from "./AgentLogo";
import {
	buildCursorInstallLink,
	buildVsCodeInstallLink,
} from "./lib/agent-sign-in";
import { agentById } from "./lib/agent-tools";
import { StepList } from "./SetupSteps";

const REPOSITORY_AFTERWARD =
	"After that, your agent compares your checkout with the published commit at each session start. Pulling stays with you.";

const UPLOAD_AFTERWARD =
	"After that, your agent reads the published instructions over MCP.";

/**
 * VS Code and Cursor install the gateway from a link, so there is nothing to
 * type. `afterward` is only said for the coding-instructions purpose, whose
 * project the editor's agent then reads instructions for.
 */
export function EditorToolSteps({
	editor,
	origin,
	projectId,
	projectName,
	afterward,
}: {
	editor: "vscode" | "cursor";
	origin: string;
	projectId: string;
	projectName: string;
	/** `null` on the project purpose, which has nothing to say after sign-in. */
	afterward: "repository" | "upload" | null;
}) {
	const agent = agentById(editor);
	const href =
		editor === "vscode"
			? buildVsCodeInstallLink(origin, projectId, projectName)
			: buildCursorInstallLink(origin, projectId, projectName);

	return (
		<StepList
			steps={[
				{
					id: "install",
					title: "Install the Fabric server",
					children: (
						<>
							<Button asChild className="gap-2.5" size="lg">
								<a
									data-testid={`agent-sign-in-${editor}`}
									href={href}
								>
									<span className="flex size-5.5 items-center justify-center rounded-md bg-background">
										<AgentLogo
											agent={agent}
											className="size-4"
										/>
									</span>
									Add to {agent.label}
									<ExternalLinkIcon
										aria-hidden="true"
										className="opacity-70"
									/>
								</a>
							</Button>
							<p className="text-muted-foreground text-sm">
								{agent.label} asks you to confirm the server.
							</p>
						</>
					),
				},
				{
					id: "approve",
					title: "Approve in your browser",
					approve: true,
					children: (
						<p className="text-muted-foreground text-sm">
							A sign-in page opens.
							{afterward === "repository"
								? ` ${REPOSITORY_AFTERWARD}`
								: null}
							{afterward === "upload"
								? ` ${UPLOAD_AFTERWARD}`
								: null}
						</p>
					),
				},
			]}
		/>
	);
}
