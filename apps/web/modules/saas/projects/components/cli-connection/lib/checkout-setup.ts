import type { LocalSetupRoute } from "../../../lib/instructions-repository-sync";
import type { CliDiscoveryState } from "./use-cli-discovery";

/**
 * What the coding-instructions purpose adds to the dialog: the one-line setup
 * for Claude Code and Codex.
 */
export interface CheckoutSetup {
	discovery: CliDiscoveryState;
	/**
	 * `null` while the project's source has not resolved, or when it is a
	 * repository this build cannot set a checkout up for.
	 */
	localSetup: LocalSetupRoute | null;
}
