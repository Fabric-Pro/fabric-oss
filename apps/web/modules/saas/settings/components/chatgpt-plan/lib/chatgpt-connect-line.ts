import {
	type CliDiscoveryDocument,
	tarballUrlOnOrigin,
} from "@saas/cli-distribution/lib/cli-discovery";
import { quoteShellArgIfNeeded } from "@saas/projects/lib/instructions-repository-sync";

export const CLI_NPM_INSTALL = "npm i -g @fabricorg/cli";

export interface ChatgptConnectLines {
	/** The line to show and copy. */
	primary: string;
	/**
	 * How the primary line runs: an installed `fabric` (`installed`), or the
	 * CLI this deployment serves, straight from its URL (`served`).
	 */
	primaryKind: "installed" | "served";
}

/**
 * The `fabric connect chatgpt` line for the page a person is looking at
 * (Fizzy #2770), built like the Connect dialog's setup line:
 *
 * - all commands explicitly target the page's address;
 * - when available, the deployment's CLI runs through `npx` from its URL, so
 *   nothing has to be installed first; only a deployment that serves no CLI
 *   falls back to an installed `fabric`.
 */
export function chatgptConnectLines(params: {
	document: CliDiscoveryDocument | null;
	origin: string;
	/** `--org <slug> --shared`: an account the organization shares. */
	sharedOrganizationSlug?: string;
}): ChatgptConnectLines {
	const { document, origin, sharedOrganizationSlug } = params;
	const args = [
		"connect chatgpt",
		...(sharedOrganizationSlug === undefined
			? []
			: [
					`--org ${quoteShellArgIfNeeded(sharedOrganizationSlug)}`,
					"--shared",
				]),
		`--base-url ${quoteShellArgIfNeeded(origin)}`,
	];
	if (document === null) {
		return {
			primary: ["fabric", ...args].join(" "),
			primaryKind: "installed",
		};
	}
	return {
		primary: [
			"npx -y",
			quoteShellArgIfNeeded(tarballUrlOnOrigin(document, origin)),
			...args,
		].join(" "),
		primaryKind: "served",
	};
}
