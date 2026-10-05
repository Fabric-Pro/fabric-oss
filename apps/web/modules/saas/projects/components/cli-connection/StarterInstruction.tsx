"use client";

import { Button } from "@ui/components/button";
import { CheckIcon, CopyIcon } from "lucide-react";

/** The project purpose's starter instruction. */
const INSTRUCTION_LABEL = "Then say this to your tool";

/**
 * Why the sentence below is a sentence to copy and not a button to press.
 *
 * There is deliberately nothing here that opens a chat for the reader. A
 * destination opened from Fabric carries the prompt text and nothing else — not
 * the configuration block — so it would start a conversation with a tool that
 * has no Fabric MCP server registered, and fail with no hint that the server
 * had to be added first (Fizzy #2457).
 */
const INSTRUCTION_INTRO =
	"Copy this sentence and send it in the tool you just connected. It only works there: the connection is what gives the tool access to this project.";

const COPY_INSTRUCTION_LABEL = "Copy instruction";

const COPIED_LABEL = "Copied";

/**
 * The one sentence a reader pastes into their coding tool on the project
 * purpose.
 *
 * Deliberately one sentence and no more. The gateway already ships a handshake
 * `instructions` block to every client that connects, and the tool descriptions
 * chain the first calls themselves, so re-teaching any of that here would spend
 * the only sentence the reader will actually paste on something they are being
 * told twice.
 */
export function buildStarterInstruction(projectName: string): string {
	return `Use the Fabric MCP server to load the context for the project "${projectName}" and help me work on it.`;
}

export function StarterInstruction({
	sentence,
	copied,
	onCopy,
}: {
	sentence: string;
	copied: boolean;
	onCopy: () => void;
}) {
	return (
		<section
			aria-labelledby="connect-cli-instruction-label"
			className="space-y-3"
		>
			<h3
				className="app-editorial-label"
				id="connect-cli-instruction-label"
			>
				{INSTRUCTION_LABEL}
			</h3>
			<p className="text-muted-foreground text-sm">{INSTRUCTION_INTRO}</p>
			<p
				className="rounded-lg border border-border bg-muted/40 p-4 text-sm"
				data-testid="connect-cli-starter-instruction"
			>
				{sentence}
			</p>
			<Button
				autoLoading={false}
				onClick={onCopy}
				size="sm"
				variant="outline"
			>
				{copied ? (
					<>
						<CheckIcon aria-hidden="true" />
						{COPIED_LABEL}
					</>
				) : (
					<>
						<CopyIcon aria-hidden="true" />
						{COPY_INSTRUCTION_LABEL}
					</>
				)}
			</Button>
		</section>
	);
}
