export type RepositoryLinks = {
	provider: string;
	repositoryUrl: string;
	ref: string;
	rootPath: string;
};

export type InstructionLink =
	| { kind: "external"; href: string }
	| { kind: "anchor"; hash: string }
	| { kind: "path"; repoPath: string; hash: string };

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function segmentsOf(path: string): string[] {
	return path.split("/").filter((segment) => segment !== "");
}

function normalize(segments: string[]): string[] {
	const out: string[] = [];
	for (const segment of segments) {
		if (segment === ".") {
			continue;
		}
		if (segment === "..") {
			out.pop();
			continue;
		}
		out.push(segment);
	}
	return out;
}

function decode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/**
 * Classifies a link written in an instruction file. A relative link names a
 * path in the repository, resolved from the folder of the file that holds it
 * (`rootPath` is where the instructions sit inside the repository); a path
 * that climbs above the repository root stops at the root.
 */
export function resolveInstructionLink(
	href: string,
	filePath: string,
	rootPath: string,
): InstructionLink {
	if (SCHEME.test(href) || href.startsWith("//")) {
		return { kind: "external", href };
	}
	if (href.startsWith("#")) {
		return { kind: "anchor", hash: href };
	}
	const hashAt = href.indexOf("#");
	const hash = hashAt === -1 ? "" : href.slice(hashAt);
	const withoutHash = hashAt === -1 ? href : href.slice(0, hashAt);
	const queryAt = withoutHash.indexOf("?");
	const target = decode(
		queryAt === -1 ? withoutHash : withoutHash.slice(0, queryAt),
	);
	const fileSegments = [...segmentsOf(rootPath), ...segmentsOf(filePath)];
	const base = target.startsWith("/") ? [] : fileSegments.slice(0, -1);
	return {
		kind: "path",
		repoPath: normalize([...base, ...segmentsOf(target)]).join("/"),
		hash,
	};
}

/** The path of a repository path inside the instructions folder, or null when it lies outside. */
export function instructionPathOf(
	repoPath: string,
	rootPath: string,
): string | null {
	const root = segmentsOf(rootPath);
	const segments = segmentsOf(repoPath);
	if (
		segments.length <= root.length ||
		root.some((segment, index) => segments[index] !== segment)
	) {
		return null;
	}
	return segments.slice(root.length).join("/");
}

function encodePath(path: string): string {
	return segmentsOf(path).map(encodeURIComponent).join("/");
}

/**
 * The web address of a path of the repository at the ref the page shows, or of
 * the ref itself when no path is given. The repository's own address for a
 * provider whose address shapes are not known here.
 */
export function repositoryWebUrl(
	links: Pick<RepositoryLinks, "provider" | "repositoryUrl" | "ref">,
	repoPath?: string,
): string {
	const base = links.repositoryUrl.replace(/\/+$/, "").replace(/\.git$/, "");
	const ref = encodePath(links.ref);
	switch (links.provider) {
		case "GITHUB":
			return repoPath
				? `${base}/blob/${ref}/${encodePath(repoPath)}`
				: `${base}/tree/${ref}`;
		case "GITLAB":
			return repoPath
				? `${base}/-/blob/${ref}/${encodePath(repoPath)}`
				: `${base}/-/tree/${ref}`;
		case "AZURE_DEVOPS": {
			const query = new URLSearchParams();
			if (repoPath) {
				query.set("path", `/${repoPath}`);
			}
			query.set("version", `GB${links.ref}`);
			return `${base}?${query}`;
		}
		default:
			return base;
	}
}
