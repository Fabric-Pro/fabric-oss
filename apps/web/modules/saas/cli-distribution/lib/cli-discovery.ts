/**
 * The CLI this deployment serves, and how it is described.
 *
 * `packages/cli/scripts/pack-deployment.mjs` writes `public/cli/manifest.json`
 * next to the tarball at build time. The manifest names the tarball by an
 * origin-relative path because the same build can answer on more than one host;
 * `/.well-known/fabric-cli.json` turns it into the absolute URL a person types
 * into `npx`.
 *
 * A build that knows its own address bakes it into the CLI, so that CLI signs
 * in there without being told, and records it as `origin`. Many builds cannot
 * know it (a preview or staging host is not known when the build runs), so
 * `origin` is `null` there. Either way the Connect dialog's line works: it
 * carries `--base-url`, which wins over the bake, unless the page is on the
 * baked address.
 */

import { z } from "zod";

export const CLI_DISCOVERY_PATH = "/.well-known/fabric-cli.json";

/** The version of the discovery document itself, not of the CLI. */
const CLI_DISCOVERY_SPEC = 1;

const VERSION = /^\d+\.\d+\.\d+$/;

/**
 * Where the tarball is served: `/cli/fabric-<version>-<build>.tgz`, `<build>`
 * being ten hex digits of the bundle's own hash. The version changes only on a
 * release while the bytes change with every build, and `npx -y <url>` keeps
 * running whatever it first fetched from a URL, so a changed build has to be at
 * a URL it has not seen. The suffix is optional only so that a deployment
 * packed before it existed still reads as serving a CLI.
 */
export const CLI_TARBALL_PATH =
	/^\/cli\/fabric-\d+\.\d+\.\d+(?:-[0-9a-f]{10})?\.tgz$/;
const SRI_SHA512 = /^sha512-[A-Za-z0-9+/]+={0,2}$/;

/** `scheme://host[:port]` exactly as `URL.origin` writes it, and nothing else. */
function isOrigin(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			(url.protocol === "https:" || url.protocol === "http:") &&
			url.origin === value
		);
	} catch {
		return false;
	}
}

/** What the pack script writes. */
const cliManifestSchema = z.object({
	spec: z.literal(CLI_DISCOVERY_SPEC),
	version: z.string().regex(VERSION),
	minSupported: z.string().regex(VERSION),
	nodeRange: z.string().min(1),
	/** The address the tarball was built to sign in at, or null when the build did not know it. */
	origin: z.string().refine(isOrigin).nullable(),
	tarball: z.string().regex(CLI_TARBALL_PATH),
	integrity: z.string().regex(SRI_SHA512),
});

export type CliManifest = z.infer<typeof cliManifestSchema>;

/** What `/.well-known/fabric-cli.json` answers: the manifest with an absolute `tarball`. */
export type CliDiscoveryDocument = Omit<CliManifest, "tarball"> & {
	tarball: string;
};

export function parseCliManifest(value: unknown): CliManifest | null {
	const parsed = cliManifestSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

/** `origin` is the host that answered, which is where the tarball is served from. */
export function discoveryDocumentFor(
	manifest: CliManifest,
	origin: string,
): CliDiscoveryDocument {
	return {
		version: manifest.version,
		spec: manifest.spec,
		integrity: manifest.integrity,
		minSupported: manifest.minSupported,
		nodeRange: manifest.nodeRange,
		origin: manifest.origin,
		tarball: `${origin.replace(/\/+$/, "")}${manifest.tarball}`,
	};
}

/**
 * Reads a discovery document a browser fetched. Anything that is not exactly
 * the shape above reads as "this deployment serves no CLI", so a proxy's error
 * page or a future spec the dialog does not know can never put a command on
 * screen.
 */
export function parseCliDiscoveryDocument(
	value: unknown,
): CliDiscoveryDocument | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const { tarball, ...rest } = value as Record<string, unknown>;
	if (typeof tarball !== "string") {
		return null;
	}
	let url: URL;
	try {
		url = new URL(tarball);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		return null;
	}
	const manifest = parseCliManifest({ ...rest, tarball: url.pathname });
	return manifest ? { ...manifest, tarball } : null;
}

/**
 * The tarball URL to put in a command, on the host the person is looking at.
 * The document's own `tarball` is the host that answered, which behind a proxy
 * or on a second domain need not be the one in the person's address bar, so the
 * dialog keeps the path and takes the origin from the page.
 */
export function tarballUrlOnOrigin(
	document: CliDiscoveryDocument,
	origin: string,
): string {
	return `${origin.replace(/\/+$/, "")}${new URL(document.tarball).pathname}`;
}
