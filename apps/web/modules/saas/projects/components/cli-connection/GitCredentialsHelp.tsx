"use client";

import { GitBranchIcon } from "lucide-react";
import type { LocalSetupRoute } from "../../lib/instructions-repository-sync";
import { CommandBlock } from "./CommandBlock";
import { DisclosureRow } from "./DisclosureRow";
import { gitCredentialHelp } from "./lib/agent-sign-in";

const SUMMARY = "Git can't sign in to the repository";

/**
 * The collapsed answer to "git says it cannot sign in". Fabric never hands out
 * repository credentials, so this is the provider's own sign-in, not a key.
 */
export function GitCredentialsHelp({
	route,
	announce,
}: {
	route: Extract<LocalSetupRoute, { kind: "repository" }>;
	announce: (message: string) => void;
}) {
	const help = gitCredentialHelp(route);
	return (
		<DisclosureRow
			icon={GitBranchIcon}
			label={SUMMARY}
			testId="connect-cli-git-credentials"
		>
			<p className="text-muted-foreground text-sm">{help.sentence}</p>
			<CommandBlock
				announce={announce}
				command={help.command}
				label="Copy the git sign-in command"
				testId="connect-cli-git-credentials-command"
			/>
		</DisclosureRow>
	);
}
