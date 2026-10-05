"use client";

import { CommandBlock } from "./CommandBlock";
import { buildPortableMcpConfiguration } from "./lib/agent-sign-in";
import { InlineCode, StepList } from "./SetupSteps";

/**
 * Any other MCP client: the server entry, with no key in it, and the approval
 * the client asks for on its first connect.
 *
 * `onUseOneLineSetup` is offered only when a one-line setup exists for this
 * project, and takes the person to the Claude Code tile, whose steps are it.
 */
export function PortableToolSteps({
	origin,
	projectId,
	announce,
	onUseOneLineSetup,
}: {
	origin: string;
	projectId: string;
	announce: (message: string) => void;
	onUseOneLineSetup: (() => void) | null;
}) {
	return (
		<StepList
			steps={[
				{
					id: "config",
					title: "Add the server to your MCP config",
					children: (
						<>
							<CommandBlock
								announce={announce}
								command={buildPortableMcpConfiguration(
									origin,
									projectId,
								)}
								label="Copy the server entry"
								layout="document"
								testId="agent-sign-in-portable"
							/>
							<p className="text-muted-foreground text-sm">
								Save as <InlineCode>.mcp.json</InlineCode> or
								paste into your tool's MCP settings.
								{onUseOneLineSetup === null ? null : (
									<>
										{" "}
										Terminal agent?{" "}
										<button
											className="text-foreground underline underline-offset-4"
											onClick={onUseOneLineSetup}
											type="button"
										>
											Use the one-line setup
										</button>
										.
									</>
								)}
							</p>
						</>
					),
				},
				{
					id: "approve",
					title: "Approve on first connect",
					approve: true,
					children: (
						<p className="text-muted-foreground text-sm">
							Any MCP client with sign-in support asks you to
							approve it in the browser.
						</p>
					),
				},
			]}
		/>
	);
}
