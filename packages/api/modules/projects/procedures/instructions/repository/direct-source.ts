/**
 * The authenticated, pinned repository source behind direct Coding
 * Instructions reads. It deliberately has no snapshot, storage or import
 * dependency: callers resolve a branch head once, then carry that commit and
 * the configuration generation through tree and file reads.
 */
import { ORPCError } from "@orpc/client";
import {
	isCommitOnBranch,
	type RepositoryApiInput,
	readRepositoryFileAtCommit,
	resolveRepositoryBranchHead,
} from "@repo/connectors";
import {
	getInstructionRepositorySync,
	getProjectInstructionSettings,
	hasProjectAccess,
} from "@repo/database";
import {
	decodeFabricIgnore,
	MAX_FABRICIGNORE_BYTES,
	resolveIgnoreGlobs,
} from "@repo/instructions";
import { PROJECT_NOT_FOUND_MESSAGE } from "../../../../../orpc/middleware/project-visibility";
import {
	assertProjectPermission,
	Permissions,
} from "../../../../../orpc/procedures";
import { requireHostingOrganizationId } from "../hosting-organization";
import {
	loadInstructionSyncIntegration,
	repositoryReadError,
	resolveInstructionSyncCredential,
} from "../repository-sync/repository";
import { commitShaSchema } from "./commit-sha";
import { directBranchMembershipCache, directFileCache } from "./direct-cache";
import { inOrder } from "./settle";

type RefreshFault = Awaited<
	ReturnType<typeof resolveInstructionSyncCredential>
>["refreshFault"];

export type DirectRepositorySource = {
	organizationId: string;
	integrationId: string;
	generation: number;
	ref: string;
	rootPath: string;
	ignoreGlobs: string[] | null;
	repository: RepositoryApiInput;
	refreshFault: RefreshFault;
};

export type DirectRepositoryPin = {
	generation: number;
	commitSha: string;
};

export async function assertDirectRepositoryReadAllowed(input: {
	projectId: string;
	userId: string;
}): Promise<void> {
	if (!(await hasProjectAccess(input.projectId, input.userId))) {
		throw new ORPCError("NOT_FOUND", {
			message: PROJECT_NOT_FOUND_MESSAGE,
		});
	}
	await assertProjectPermission(
		input.projectId,
		input.userId,
		Permissions.INSTRUCTION_READ,
	);
}

function notRepositorySourced(): ORPCError<
	"PRECONDITION_FAILED",
	{ code: string }
> {
	return new ORPCError("PRECONDITION_FAILED", {
		message:
			"This project's coding instructions are uploaded, not connected directly to a repository.",
		data: { code: "NOT_REPOSITORY_SOURCED" },
	});
}

function migrationInProgress(): ORPCError<
	"PRECONDITION_FAILED",
	{ code: string }
> {
	return new ORPCError("PRECONDITION_FAILED", {
		message:
			"Repository migration is still in progress. Uploaded instructions remain authoritative until it finishes.",
		data: { code: "INSTRUCTION_MIGRATION_IN_PROGRESS" },
	});
}

function configurationChanged(): ORPCError<"CONFLICT", { code: string }> {
	return new ORPCError("CONFLICT", {
		message: "The repository configuration changed. Refresh and try again.",
		data: { code: "REPOSITORY_CONFIGURATION_CHANGED" },
	});
}

function commitNotFound(): ORPCError<"NOT_FOUND", { code: string }> {
	return new ORPCError("NOT_FOUND", {
		message: "That commit is not on the configured repository branch",
		data: { code: "COMMIT_NOT_FOUND" },
	});
}

export function directRepositoryReadError(
	source: Pick<DirectRepositorySource, "ref" | "rootPath" | "refreshFault">,
	outcome: "not-found" | "unauthorized" | "unreachable" | "missing-path",
): ORPCError<string, unknown> {
	return repositoryReadError(outcome, {
		ref: source.ref,
		path: source.rootPath,
		refreshFault: source.refreshFault,
		unreachableMessage:
			"Couldn't reach the repository to read coding instructions. Try again.",
	});
}

/**
 * Resolves the configured repository server-side after the procedure's
 * visibility and INSTRUCTION_READ gates. The integration's credential is
 * never taken from a request.
 */
type DirectRepositoryConfiguration = Omit<
	DirectRepositorySource,
	"repository" | "refreshFault"
> & {
	repository: Pick<
		RepositoryApiInput,
		"provider" | "repositoryUrl" | "owner" | "repo" | "azureOrganization"
	>;
};

/**
 * Everything about the connection that identifies it, with no credential
 * work: the hosting organization, the repository mode and its ignore
 * settings, and the project's own ACTIVE integration.
 */
async function loadDirectRepositoryConfiguration(input: {
	projectId: string;
	userId: string;
	signal?: AbortSignal;
}): Promise<{
	configuration: DirectRepositoryConfiguration;
	integration: Awaited<ReturnType<typeof loadInstructionSyncIntegration>>;
}> {
	input.signal?.throwIfAborted();
	const organizationId = await requireHostingOrganizationId(
		input.projectId,
		input.userId,
	);
	const [settings, sync] = await Promise.all([
		getProjectInstructionSettings(input.projectId, organizationId),
		getInstructionRepositorySync(input.projectId, organizationId),
	]);
	if (settings.sourceOfTruth !== "REPOSITORY") {
		throw notRepositorySourced();
	}
	if (settings.migration !== null) {
		throw migrationInProgress();
	}
	if (!sync) {
		throw new ORPCError("PRECONDITION_FAILED", {
			message: "Connect a repository to read coding instructions.",
			data: { code: "REPOSITORY_UNAVAILABLE" },
		});
	}
	input.signal?.throwIfAborted();
	const integration = await loadInstructionSyncIntegration({
		repositoryIntegrationId: sync.repositoryIntegrationId,
		projectId: input.projectId,
	});
	return {
		integration,
		configuration: {
			organizationId,
			integrationId: integration.id,
			generation: sync.generation,
			ref: sync.ref,
			rootPath: sync.rootPath,
			ignoreGlobs: settings.ignoreGlobs,
			repository: {
				provider: integration.provider,
				repositoryUrl: integration.repositoryUrl,
				owner: integration.repositoryOwner,
				repo: integration.repositoryName,
				azureOrganization: integration.azureOrganization,
			},
		},
	};
}

export async function loadDirectRepositorySource(input: {
	projectId: string;
	userId: string;
	signal?: AbortSignal;
}): Promise<DirectRepositorySource> {
	const { configuration, integration } =
		await loadDirectRepositoryConfiguration(input);
	// The caller's live permission is read while the credential resolves, and
	// wins over a credential failure, so a revoked caller learns nothing of it.
	const [, { token, refreshFault }] = await inOrder(
		assertDirectRepositoryReadAllowed(input),
		resolveInstructionSyncCredential(integration, {
			userId: input.userId,
			organizationId: configuration.organizationId,
		}),
	);
	input.signal?.throwIfAborted();
	return {
		...configuration,
		repository: {
			signal: input.signal,
			...configuration.repository,
			token,
			...(integration.provider === "GITLAB" &&
			integration.authMethod === "PAT"
				? { gitlabAuth: "private-token" as const }
				: {}),
			...(integration.provider === "AZURE_DEVOPS" &&
			integration.authMethod !== "PAT"
				? { azureDevOpsAuth: "bearer" as const }
				: {}),
		},
		refreshFault,
	};
}

/** Resolve the current configured branch head once for one logical request. */
export async function resolveDirectRepositoryHead(
	source: DirectRepositorySource,
): Promise<DirectRepositoryPin> {
	const result = await resolveRepositoryBranchHead({
		...source.repository,
		branch: source.ref,
	});
	if (!result.ok) {
		throw directRepositoryReadError(source, result.outcome);
	}
	if (!commitShaSchema.safeParse(result.commitSha).success) {
		throw directRepositoryReadError(source, "unreachable");
	}
	return { generation: source.generation, commitSha: result.commitSha };
}

/**
 * A client-supplied pin must still name the same repository configuration and
 * a commit reachable from its configured branch. This permits an older
 * ancestor after an ordinary branch advance but never arbitrary PR content.
 */
export async function assertDirectRepositoryPin(
	source: DirectRepositorySource,
	pin: DirectRepositoryPin,
): Promise<void> {
	if (pin.generation !== source.generation) {
		throw configurationChanged();
	}
	if (
		directBranchMembershipCache.get(source, [source.ref, pin.commitSha]) ===
		true
	) {
		return;
	}
	const result = await isCommitOnBranch({
		...source.repository,
		branch: source.ref,
		sha: pin.commitSha,
	});
	if (!result.ok) {
		if (result.outcome === "not-found") {
			throw commitNotFound();
		}
		throw directRepositoryReadError(source, result.outcome);
	}
	if (!result.onBranch) {
		throw commitNotFound();
	}
	directBranchMembershipCache.set(source, [source.ref, pin.commitSha], true);
}

function sameOptionalStrings(
	left: string[] | null,
	right: string[] | null,
): boolean {
	return (
		left === right ||
		(left !== null &&
			right !== null &&
			left.length === right.length &&
			left.every((value, index) => value === right[index]))
	);
}

function sameRepositoryConfiguration(
	left: DirectRepositoryConfiguration,
	right: DirectRepositoryConfiguration,
): boolean {
	return (
		left.organizationId === right.organizationId &&
		left.integrationId === right.integrationId &&
		left.generation === right.generation &&
		left.ref === right.ref &&
		left.rootPath === right.rootPath &&
		sameOptionalStrings(left.ignoreGlobs, right.ignoreGlobs) &&
		left.repository.provider === right.repository.provider &&
		left.repository.repositoryUrl === right.repository.repositoryUrl &&
		left.repository.owner === right.repository.owner &&
		left.repository.repo === right.repository.repo &&
		left.repository.azureOrganization === right.repository.azureOrganization
	);
}

/**
 * Recheck the caller's live read permission and the complete repository
 * configuration after provider I/O, before its result leaves the server. A
 * replacement integration, root or generation can therefore never serve a
 * stale pinned response.
 */
export async function assertDirectRepositorySourceCurrent(input: {
	projectId: string;
	userId: string;
	source: DirectRepositorySource;
}): Promise<void> {
	const [, current] = await inOrder(
		assertDirectRepositoryReadAllowed(input),
		loadDirectRepositoryConfiguration(input),
	);
	if (!sameRepositoryConfiguration(input.source, current.configuration)) {
		throw configurationChanged();
	}
}

/** One file at the pinned commit, from the commit-addressed cache when it was read already. */
export async function readDirectRepositoryFileAtCommit(
	source: DirectRepositorySource,
	pin: DirectRepositoryPin,
	path: string,
	maxBytes: number,
): ReturnType<typeof readRepositoryFileAtCommit> {
	const cached = directFileCache.get(source, [pin.commitSha, maxBytes, path]);
	if (cached !== undefined) {
		return cached;
	}
	const read = await readRepositoryFileAtCommit({
		...source.repository,
		sha: pin.commitSha,
		path,
		maxBytes,
	});
	if (read.ok) {
		directFileCache.set(source, [pin.commitSha, maxBytes, path], read);
	}
	return read;
}

/**
 * Resolve the root ignore rules from the same pinned commit as tree and file
 * reads. `.fabricignore` is bounded and decoded as bytes; direct reads do not
 * scan file content or turn provider bytes into checkout text.
 */
export async function resolveDirectRepositoryIgnore(
	source: DirectRepositorySource,
	pin: DirectRepositoryPin,
): Promise<ReturnType<typeof resolveIgnoreGlobs>> {
	const path =
		source.rootPath === ""
			? ".fabricignore"
			: `${source.rootPath}/.fabricignore`;
	const read = await readDirectRepositoryFileAtCommit(
		source,
		pin,
		path,
		MAX_FABRICIGNORE_BYTES,
	);
	if (!read.ok) {
		if (read.outcome === "unsupported") {
			throw directRepositoryReadError(source, "unreachable");
		}
		throw directRepositoryReadError(source, read.outcome);
	}
	if (read.state === "absent") {
		return resolveIgnoreGlobs({ projectGlobs: source.ignoreGlobs });
	}
	if (read.state === "tooLarge") {
		throw new ORPCError("BAD_REQUEST", {
			message:
				"The repository's .fabricignore file is too large to read.",
			data: { code: "REPOSITORY_IGNORE_TOO_LARGE" },
		});
	}
	const decoded = decodeFabricIgnore(read.bytes);
	if (!decoded.ok) {
		throw new ORPCError("BAD_REQUEST", {
			message: "The repository's .fabricignore file is not valid UTF-8.",
			data: { code: "REPOSITORY_IGNORE_INVALID" },
		});
	}
	return resolveIgnoreGlobs({
		fabricIgnoreText: decoded.text,
		projectGlobs: source.ignoreGlobs,
	});
}

/** Provider path for a path relative to the configured repository root. */
export function directRepositoryPath(
	source: Pick<DirectRepositorySource, "rootPath">,
	path: string,
): string {
	return source.rootPath === "" ? path : `${source.rootPath}/${path}`;
}

/** Relative path inside the configured root, or null when the provider entry is outside it. */
export function directRelativeRepositoryPath(
	source: Pick<DirectRepositorySource, "rootPath">,
	path: string,
): string | null {
	if (source.rootPath === "") {
		return path;
	}
	const prefix = `${source.rootPath}/`;
	return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}
