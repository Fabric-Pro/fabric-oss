"use client";

import { Button } from "@ui/components/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { CheckIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import { useRef, useState } from "react";
import {
	buildClaudeCodeCommand,
	buildCodexCommands,
	buildCursorInstallLink,
	buildPortableMcpConfiguration,
	buildVsCodeInstallLink,
} from "./lib/agent-sign-in";

/* -------------------------------------------------------------------------- */
/* Copy                                                                        */
/* -------------------------------------------------------------------------- */

const SECTION_LABEL = "Connect your coding agent";

const SECTION_INTRO =
	"Add Fabric to your tool, then sign in from the tool. You approve it once in your browser, for this organization. Nothing here contains a key, so it is safe to share or commit.";

const CLAUDE_CODE_NEXT_STEP =
	"Then run /mcp in Claude Code and choose Authenticate. Your browser opens so you can approve the connection.";

const VS_CODE_NEXT_STEP =
	"VS Code asks you to confirm the server, then opens your browser to sign in.";

const CURSOR_NEXT_STEP =
	"Cursor asks you to confirm the server, then opens your browser to sign in.";

const CODEX_NEXT_STEP =
	"The second command opens your browser so you can approve the connection.";

const PORTABLE_NEXT_STEP =
	"Save this as .mcp.json, or add the server to your tool's MCP settings. A client that supports sign-in will offer it the first time it connects.";

const COPIED_LABEL = "Copied";
const COPY_FAILED = "Copying failed. Select the text and copy it manually.";

const AGENTS: ReadonlyArray<{ id: AgentId; label: string }> = [
	{ id: "claude-code", label: "Claude Code" },
	{ id: "vscode", label: "VS Code" },
	{ id: "cursor", label: "Cursor" },
	{ id: "codex", label: "Codex" },
	{ id: "other", label: "Other" },
];

type AgentId = "claude-code" | "vscode" | "cursor" | "codex" | "other";

interface AgentSignInSectionProps {
	/** The deployment origin the entries point at. Empty until mounted. */
	origin: string;
	/**
	 * The heading. The dialog names this section differently when the
	 * checkout route is offered first.
	 */
	label?: string;
	/**
	 * Says a copy's outcome through the host's live region. The dialog keeps
	 * exactly one, so this section adds none of its own.
	 */
	announce: (message: string) => void;
}

function CommandBlock({
	command,
	label,
	testId,
	announce,
}: {
	command: string;
	/** Unique in the dialog: the key route has copy controls of its own. */
	label: string;
	testId: string;
	announce: (message: string) => void;
}) {
	const [state, setState] = useState<"idle" | "copied">("idle");
	const generation = useRef(0);

	const copy = async () => {
		const current = ++generation.current;
		try {
			await navigator.clipboard.writeText(command);
			if (current === generation.current) {
				setState("copied");
				announce(`${label}: copied to the clipboard.`);
			}
		} catch {
			if (current === generation.current) {
				setState("idle");
				announce(COPY_FAILED);
			}
		}
	};

	return (
		<div className="space-y-2">
			<pre
				className="whitespace-pre-wrap break-all rounded-lg border border-border bg-muted p-4 font-mono text-xs"
				data-testid={testId}
			>
				{command}
			</pre>
			<Button
				autoLoading={false}
				onClick={copy}
				size="sm"
				variant="outline"
			>
				{state === "copied" ? (
					<>
						<CheckIcon aria-hidden="true" />
						{COPIED_LABEL}
					</>
				) : (
					<>
						<CopyIcon aria-hidden="true" />
						{label}
					</>
				)}
			</Button>
		</div>
	);
}

/**
 * The default way to connect a coding tool: one action per tool, no key.
 *
 * The tool is pointed at the gateway, the gateway answers 401 with a pointer to
 * its sign-in metadata, and the tool walks the person through approving it in
 * the browser. See `./lib/agent-sign-in.ts` for where each format comes from.
 */
export function AgentSignInSection({
	origin,
	label = SECTION_LABEL,
	announce,
}: AgentSignInSectionProps) {
	return (
		<section
			aria-labelledby="agent-sign-in-label"
			className="space-y-3"
			data-testid="agent-sign-in"
		>
			<h3 id="agent-sign-in-label" className="app-editorial-label">
				{label}
			</h3>
			<p className="text-muted-foreground text-sm">{SECTION_INTRO}</p>

			<Tabs defaultValue="claude-code">
				<TabsList aria-label={SECTION_LABEL} className="flex-wrap">
					{AGENTS.map((agent) => (
						<TabsTrigger key={agent.id} value={agent.id}>
							{agent.label}
						</TabsTrigger>
					))}
				</TabsList>

				<TabsContent className="space-y-3 pt-3" value="claude-code">
					<CommandBlock
						announce={announce}
						command={buildClaudeCodeCommand(origin)}
						label="Copy the Claude Code command"
						testId="agent-sign-in-claude-code"
					/>
					<p className="text-muted-foreground text-sm">
						{CLAUDE_CODE_NEXT_STEP}
					</p>
				</TabsContent>

				<TabsContent className="space-y-3 pt-3" value="vscode">
					<Button asChild>
						<a
							data-testid="agent-sign-in-vscode"
							href={buildVsCodeInstallLink(origin)}
						>
							<ExternalLinkIcon aria-hidden="true" />
							Add to VS Code
						</a>
					</Button>
					<p className="text-muted-foreground text-sm">
						{VS_CODE_NEXT_STEP}
					</p>
				</TabsContent>

				<TabsContent className="space-y-3 pt-3" value="cursor">
					<Button asChild>
						<a
							data-testid="agent-sign-in-cursor"
							href={buildCursorInstallLink(origin)}
						>
							<ExternalLinkIcon aria-hidden="true" />
							Add to Cursor
						</a>
					</Button>
					<p className="text-muted-foreground text-sm">
						{CURSOR_NEXT_STEP}
					</p>
				</TabsContent>

				<TabsContent className="space-y-3 pt-3" value="codex">
					<CommandBlock
						announce={announce}
						command={buildCodexCommands(origin)}
						label="Copy the Codex commands"
						testId="agent-sign-in-codex"
					/>
					<p className="text-muted-foreground text-sm">
						{CODEX_NEXT_STEP}
					</p>
				</TabsContent>

				<TabsContent className="space-y-3 pt-3" value="other">
					<CommandBlock
						announce={announce}
						command={buildPortableMcpConfiguration(origin)}
						label="Copy the server entry"
						testId="agent-sign-in-portable"
					/>
					<p className="text-muted-foreground text-sm">
						{PORTABLE_NEXT_STEP}
					</p>
				</TabsContent>
			</Tabs>
		</section>
	);
}
