/**
 * Coding Instructions sets, as the CLI sees them.
 *
 * A project has one Coding Instructions source. A project may split it into
 * named sets: a set is a folder of that source (`instructions/<slug>/`, or the
 * root minus every other set's folder for the default set) and the code
 * repositories it applies to. A plugin built for a set carries only the set's
 * files, with the set's folder taken off their paths, so
 * `instructions/mobile/skills/a/SKILL.md` is the `mobile` plugin's
 * `skills/a/SKILL.md`.
 *
 * The default set, and a project with no sets at all, keep the plugin name and
 * folders every install had before sets existed; only a non-default set gets a
 * plugin of its own (`<name>-<slug>`).
 */
import type {
	FabricClient,
	InstructionSet,
	ProjectCodeRepository,
} from "@fabricorg/sdk";
import { CliFailure } from "../command-boundary.js";
import { parseRemoteUrl } from "../instructions/repository-identity.js";

/** The default set's slug (`DEFAULT_INSTRUCTION_SET_SLUG` on the server). */
const DEFAULT_SET_SLUG = "default";

/** Which files of the source belong to a set. */
export interface InstructionSetScope {
	/** `instructions/<slug>/`, or `""` for the default set. */
	folder: string;
	/** Folders under `folder` that are other sets'. */
	excludedFolders: readonly string[];
}

/**
 * Where a file of the instructions source sits within a set: its path
 * relative to the set's folder, or null when the file is not the set's.
 * Without a set every file is its own.
 *
 * Keep in step with `pathInInstructionSet` in
 * packages/database/prisma/queries/instruction-set-management.ts: the CLI is
 * a published package and cannot import `@repo/*`, so the rule is repeated
 * here, and the server and the plugin must agree on which files a set holds.
 */
export function pathInInstructionSet(
	path: string,
	set: InstructionSetScope | null,
): string | null {
	if (!set) {
		return path;
	}
	if (!path.startsWith(set.folder)) {
		return null;
	}
	if (set.excludedFolders.some((folder) => path.startsWith(folder))) {
		return null;
	}
	return path.slice(set.folder.length);
}

/** A set slug as the server makes them: lowercase letters, digits and single dashes, 2-40 long. */
export function isSetSlug(value: string): boolean {
	return (
		/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/.test(value) &&
		!value.includes("--")
	);
}

/**
 * The set that gives a plugin its own identity: `null` for no set and for the
 * default set, which keep the project's plugin as it always was.
 */
export function pluginSetSlug(set: string | null | undefined): string | null {
	return set === undefined || set === null || set === DEFAULT_SET_SLUG
		? null
		: set;
}

/** The folder of a project's (or a set's) rendered Claude Code plugins in the CLI's cache. */
export function pluginCacheKey(projectId: string, set?: string | null): string {
	const slug = pluginSetSlug(set);
	return slug === null ? projectId : `${projectId}--${slug}`;
}

/**
 * Whether a git remote names this code repository: scheme, userinfo, a `.git`
 * suffix, a trailing slash and the host's letter case do not matter, nor
 * which of the https, ssh and scp-like (`git@host:owner/repo`) spellings
 * either side uses. GitHub paths compare ignoring case; GitLab paths exactly;
 * Azure DevOps by organization, project and repository, whichever of its
 * spellings either side came in.
 */
export function remoteNamesRepository(
	remoteUrl: string,
	repository: Pick<ProjectCodeRepository, "provider" | "cloneUrl">,
): boolean {
	const remote = parseRemoteUrl(remoteUrl);
	const target = parseRemoteUrl(repository.cloneUrl);
	if (remote === null || target === null) {
		return false;
	}
	if (remote.azure !== undefined || target.azure !== undefined) {
		const a = remote.azure;
		const b = target.azure;
		if (
			a === undefined ||
			b === undefined ||
			a.project === null ||
			b.project === null
		) {
			return false;
		}
		const same = (x: string, y: string) =>
			x.toLowerCase() === y.toLowerCase();
		return (
			same(a.organization, b.organization) &&
			same(a.project, b.project) &&
			same(a.repository, b.repository)
		);
	}
	if (remote.host !== target.host) {
		return false;
	}
	return repository.provider === "GITLAB"
		? remote.path === target.path
		: remote.path.toLowerCase() === target.path.toLowerCase();
}

function slugList(sets: readonly InstructionSet[]): string {
	return sets.map((set) => set.slug).join(", ");
}

/** The set named `--set`, or a failure that lists the ones there are. */
function findInstructionSet(
	sets: readonly InstructionSet[],
	slug: string,
): InstructionSet {
	if (sets.length === 0) {
		throw new CliFailure(
			`This project has no Coding Instructions sets, so --set ${isSetSlug(slug) ? slug : "<slug>"} names none. Run this again without --set.`,
			2,
		);
	}
	const found = sets.find((set) => set.slug === slug);
	if (found === undefined) {
		throw new CliFailure(
			`This project has no Coding Instructions set ${isSetSlug(slug) ? `"${slug}"` : "by that name"}. Its sets are: ${slugList(sets)}. Pass one of them to --set.`,
			2,
		);
	}
	return found;
}

/** The default set, when the project has sets. */
function defaultInstructionSet(
	sets: readonly InstructionSet[],
): InstructionSet | null {
	return (
		sets.find((set) => set.isDefault) ??
		sets.find((set) => set.slug === DEFAULT_SET_SLUG) ??
		null
	);
}

export interface SetResolution {
	listSets(): Promise<InstructionSet[]>;
	listCodeRepositories(): Promise<ProjectCodeRepository[]>;
	/** The fetch URLs of the checkout's remotes; `[]` outside a git checkout. */
	remoteUrls(): Promise<string[]>;
	/** Asks which of several sets; `null` when nobody can answer. */
	choose?: (sets: InstructionSet[]) => Promise<number | null>;
}

/**
 * The set `init` sets up, or `null` for a project without sets (everything as
 * before sets existed).
 *
 * `--set` names it. Otherwise the checkout's remotes are matched with the
 * project's code repositories: a checkout of none of them gets the default
 * set; a checkout of one gets the set that applies to it, or a question when
 * several do. A repository no set applies to gets no instructions, which is
 * an error rather than a silent default.
 */
export async function resolveInstructionSet(
	requested: string | undefined,
	deps: SetResolution,
): Promise<InstructionSet | null> {
	const sets = await deps.listSets();
	if (requested !== undefined) {
		return findInstructionSet(sets, requested);
	}
	if (sets.length === 0) {
		return null;
	}
	const remotes = await deps.remoteUrls();
	const repositories =
		remotes.length === 0 ? [] : await deps.listCodeRepositories();
	const matched = repositories.filter((repository) =>
		remotes.some((url) => remoteNamesRepository(url, repository)),
	);
	if (matched.length === 0) {
		const fallback = defaultInstructionSet(sets);
		if (fallback === null) {
			throw new CliFailure(
				`This folder is not a checkout of one of the project's code repositories, and the project has no default Coding Instructions set. Pass --set with one of: ${slugList(sets)}.`,
				2,
			);
		}
		return fallback;
	}
	const ids = new Set(matched.map((repository) => repository.id));
	const applying = sets.filter((set) =>
		set.repositoryIntegrationIds.some((id) => ids.has(id)),
	);
	const names = matched.map((repository) => repository.name).join(", ");
	if (applying.length === 1) {
		return applying[0] as InstructionSet;
	}
	if (applying.length === 0) {
		throw new CliFailure(
			`No Coding Instructions set covers ${names}, so this checkout gets no instructions. The project's sets are: ${slugList(sets)}. Ask a project admin to add the repository to a set in the Coding Instructions tab, or pass --set to choose one.`,
			2,
		);
	}
	const picked = deps.choose ? await deps.choose(applying) : null;
	const chosen = picked === null ? undefined : applying[picked];
	if (chosen === undefined) {
		throw new CliFailure(
			`Several Coding Instructions sets cover ${names}: ${slugList(applying)}. Pass --set with the one to use.`,
			2,
		);
	}
	return chosen;
}

/** The code repositories a set applies to, in the order the project lists them. */
function repositoriesOfSet(
	set: Pick<InstructionSet, "repositoryIntegrationIds">,
	repositories: readonly ProjectCodeRepository[],
): ProjectCodeRepository[] {
	const ids = new Set(set.repositoryIntegrationIds);
	return repositories.filter((repository) => ids.has(repository.id));
}

/** The file in a set's plugin that names the code repositories the set applies to. */
export const REPOSITORIES_FILE = "instructions/REPOSITORIES.md";

function credentialFree(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.username = "";
		parsed.password = "";
		return parsed.toString();
	} catch {
		// scp-like spellings carry a user, never a secret.
		return url;
	}
}

/**
 * `REPOSITORIES.md` of a set's plugin: generated, deterministic (sorted by
 * workspace folder), so the same repositories always give the same bytes and
 * the plugin's version does not churn.
 */
export function repositoriesMarkdown(
	set: Pick<InstructionSet, "name" | "slug">,
	repositories: readonly ProjectCodeRepository[],
): string {
	const sorted = [...repositories].sort((a, b) =>
		a.folder < b.folder
			? -1
			: a.folder > b.folder
				? 1
				: a.id < b.id
					? -1
					: a.id > b.id
						? 1
						: 0,
	);
	const lines = [
		"<!-- Generated by Fabric. Do not edit: changes are overwritten on the next render. -->",
		"",
		`# Code repositories of the "${set.name}" Coding Instructions set (\`${set.slug}\`)`,
		"",
		"These instructions apply to the code repositories below. Each is cloned in the agent workspace at its folder; clone a missing one from the workspace root with plain git.",
		"",
	];
	if (sorted.length === 0) {
		lines.push("No code repository is assigned to this set yet.");
	}
	for (const repository of sorted) {
		lines.push(
			`## ${repository.name}`,
			"",
			`- Clone URL: ${credentialFree(repository.cloneUrl)}`,
			`- Default branch: ${repository.defaultBranch}`,
			`- Role: ${repository.roleTag ?? "none"}`,
			`- Workspace folder: \`repos/${repository.folder}\``,
			"",
		);
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

/** A set a render uses, with the code repositories it applies to. */
export interface RenderSet {
	set: InstructionSet;
	repositories: ProjectCodeRepository[];
}

/**
 * The set a render (or the rules hook) uses: the one `--set` names, else the
 * default set when the project has sets, else none. A render never looks at
 * a checkout (Claude Code runs it from the home folder), so a project's own
 * plugin, installed before sets existed, carries the default set. A
 * deployment that does not know sets (404) is a project without them, unless
 * a set was asked for.
 */
export async function loadRenderSet(input: {
	client: Pick<FabricClient, "projects">;
	projectId: string;
	org?: string;
	set?: string;
	/** Also read the code repositories (for `REPOSITORIES.md`). */
	withRepositories?: boolean;
}): Promise<RenderSet | null> {
	let sets: InstructionSet[];
	try {
		sets = (
			await input.client.projects.listInstructionSets(input.projectId, {
				org: input.org,
			})
		).sets;
	} catch (error) {
		if (
			input.set === undefined &&
			(error as { status?: number }).status === 404
		) {
			return null;
		}
		throw error;
	}
	const set =
		input.set === undefined
			? defaultInstructionSet(sets)
			: findInstructionSet(sets, input.set);
	if (set === null) {
		if (sets.length > 0) {
			throw new CliFailure(
				`This project has Coding Instructions sets but no default set. Pass --set with one of: ${slugList(sets)}.`,
				2,
			);
		}
		return null;
	}
	const repositories =
		input.withRepositories === true
			? repositoriesOfSet(
					set,
					(
						await input.client.projects.listCodeRepositories(
							input.projectId,
							{ org: input.org },
						)
					).repositories,
				)
			: [];
	return { set, repositories };
}
