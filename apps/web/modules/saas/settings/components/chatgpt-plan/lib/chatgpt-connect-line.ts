import {
	type CliDiscoveryDocument,
	tarballUrlOnOrigin,
} from "@saas/cli-distribution/lib/cli-discovery";
import { quoteShellArgIfNeeded } from "@saas/projects/lib/instructions-repository-sync";

/**
 * Where an installed `fabric` signs in when told nothing. Mirrors
 * `DEFAULT_ORIGIN` in `packages/cli/src/lib/origin.ts`; a test pins the two
 * equal.
 */
export const CLI_DEFAULT_ORIGIN = "https://fabric.pro";

export const CLI_NPM_INSTALL = "npm i -g @fabricorg/cli";

export interface ChatgptConnectLines {
	/** The line to show and copy. */
	primary: string;
	/**
	 * How the primary line runs: an installed `fabric` (`installed`), or the
	 * CLI this deployment serves, straight from its URL (`served`).
	 */
	primaryKind: "installed" | "served";
	/** The served-CLI line, offered for someone with no CLI yet; null when there is none or it is already primary. */
	servedLine: string | null;
}

/**
 * The `fabric connect chatgpt` line for the page a person is looking at
 * (Fizzy #2770), built like the Connect dialog's setup line:
 *
 * - all commands explicitly target the page's address;
 * - when available, the deployment's CLI is offered through `npx` from its URL.
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
	const installed = ["fabric", ...args].join(" ");
	const served = document
		? [
				"npx -y",
				quoteShellArgIfNeeded(tarballUrlOnOrigin(document, origin)),
				...args,
			].join(" ")
		: null;

	if (served === null) {
		return {
			primary: installed,
			primaryKind: "installed",
			servedLine: null,
		};
	}
	if (origin === CLI_DEFAULT_ORIGIN) {
		return {
			primary: installed,
			primaryKind: "installed",
			servedLine: served,
		};
	}
	return { primary: served, primaryKind: "served", servedLine: null };
}
