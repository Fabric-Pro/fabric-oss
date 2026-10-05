/**
 * One admission for every "Suggest a change" surface (Fizzy #2563 spec §5.1):
 * the tab's `derive` and the inline entry point (`submit-change.ts`) behind
 * REST v1, MCP and the CLI both call `admitInstructionProposal`, so a
 * repository-backed project answers the same way wherever the change comes
 * from.
 *
 * An upload-backed project is a FABRIC destination and nothing about its path
 * changes except the note. A repository-backed project admits a proposal as a
 * pull-request operation: the destination is FROZEN here (spec §2.2) — the
 * sync row's id and current generation, the integration, the target ref and
 * root, the base commit, the repository identity and the rendered commit
 * attribution and message — and creation-side steps later check the
 * configuration still equals it rather than re-resolving it.
 *
 * Every new REPOSITORY admission is a member branch proposal: its frozen
 * context is `pullRequestContext` v2 (Fizzy #2738 spec Decision 4, §4.2),
 * which has no per-proposal branch, title or body, because the member's
 * branch owns its ref and its pull request's title and description (spec
 * Decision 13). Rows admitted before keep their v1 context, which is read for
 * display only: #2563's per-proposal path that acted on them was retired
 * once they drained (Fizzy #2748). Direct derives and publish mode keep the
 * `REPOSITORY_SOURCE_OF_TRUTH` refusal: a repository-backed project changes
 * through git, and a proposal is the one way to ask git for a change.
 *
 * The order is the spec's: destination, sync row, integration, repository
 * identity, authority, base, then the note's rendering. Authority comes after
 * the configuration reads because it depends on one of them (the
 * `allowReaderProposals` opt-in lives on the sync row), and before the base,
 * so a caller without standing learns nothing about the published snapshot.
 */

import { ORPCError } from "@orpc/client";
import { createId } from "@paralleldrive/cuid2";
import { config } from "@repo/config";
import {
	db,
	getInstructionRepositorySyncForProposal,
	getProjectInstructionSettings,
	getPublishedInstructionSnapshot,
	type InstructionMigrationPointer,
	type PullRequestFailure,
	type RepositoryProposalDestination,
	type UploadStartedAuditTemplate,
} from "@repo/database";
import {
	type DirectCommitContext,
	FALLBACK_PROPOSER_NAME,
	type ProposalNote,
	PULL_REQUEST_COMMITTER_NAME,
	type PullRequestContextV2,
	proposalNoteSchema,
	renderDirectCommitText,
	renderPullRequestText,
} from "@repo/instructions";
import { repositoryIdentity } from "@repo/integrations/instruction-pull-requests";
import {
	type AuditRequestContext,
	auditRequestFields,
	resolveActor,
} from "../../../../lib/audit";
import { migrationOpenError } from "./migration-freeze";
import { assertRepositoryProposalAccess } from "./proposal-authorization";

/**
 * What the caller is asking for. `proposal` is the reviewed path; `publish`
 * is the inline entry point's unreviewed one and `direct` the tab's direct
 * save. A proposal can reach a REPOSITORY destination; `commit` (Fizzy #2878
 * §10) is a member with write rights committing straight to the synced branch
 * and is admitted only for a repository-backed project.
 */
type AdmissionMode = "proposal" | "publish" | "direct" | "commit" | "migration";

export type AdmissionInput = {
	projectId: string;
	/** The project's hosting organization, already resolved server-side. */
	organizationId: string;
	userId: string;
	/**
	 * `migration` (Fizzy #2878 §9) is the move of an upload-backed project's
	 * published tree into a repository: the one admission of a REPOSITORY
	 * proposal for a project that is still upload-backed, made against the
	 * sync row the move created and the branch tip the caller read
	 * (`baseCommitSha`). Every other mode is refused while a move is open.
	 */
	mode: AdmissionMode;
	/** `migration` only: the synced branch's tip the move's commit is built on. */
	baseCommitSha?: string;
	/** The raw `note` from the request; parsed here with `proposalNoteSchema`. */
	note?: unknown;
	/** The proposer's display name, a body input only (spec §5.2). */
	proposerName: string | null | undefined;
	/** How many paths the change set touches, for the default title. */
	fileCount: number;
	/** `commit` only: the committer's own message, rendered here and frozen. */
	message?: string;
};

export type RepositoryAdmission = {
	destination: "REPOSITORY";
	note: ProposalNote | null;
	/**
	 * `pullRequestOperationId`: the proposal's durable id, and its commits'
	 * `Fabric-Change` trailer (spec Decision 13).
	 */
	operationId: string;
	/** The frozen member branch context (spec Decision 4): v2 for every admission. */
	context: PullRequestContextV2;
	syncId: string;
	syncGeneration: number;
	/** Attribution refused at admission: the row is admitted BLOCKED and nothing is pushed. */
	blocked?: PullRequestFailure;
};

/**
 * A direct commit to the synced branch (Fizzy #2878 §10): the frozen
 * destination and the rendered commit text, stored as the snapshot's
 * `commitContext`. There is no note and no pull request.
 */
type CommitAdmission = {
	destination: "REPOSITORY_COMMIT";
	note: null;
	context: DirectCommitContext;
};

export type Admission =
	| { destination: "FABRIC"; note: ProposalNote | null }
	| RepositoryAdmission
	| CommitAdmission;

/** Kept word for word from the refusal both call sites gave before this. */
const REPOSITORY_SOURCE_OF_TRUTH_MESSAGE =
	"This project's coding instructions come from its repository. Change the files there and sync the project.";

const REPOSITORY_UNAVAILABLE_MESSAGE =
	"The repository connection for this project's coding instructions is not available. Reconnect it in the project's repository settings, then try again.";

/** Spec §5.1 step 3: Fabric never invents an Azure DevOps project. */
const ADO_PROJECT_MESSAGE =
	"Reconnect the repository with a URL that names its Azure DevOps project.";

const REPOSITORY_BASE_UNAVAILABLE_MESSAGE =
	"Sync the repository before proposing a change.";

/** A direct commit needs a branch to commit to (Fizzy #2878 §10). */
const NOT_REPOSITORY_SOURCED_MESSAGE =
	"This project's coding instructions are uploaded, not synced from a repository, so there is no branch to commit to.";

type RefusalReason =
	| "REPOSITORY_SOURCE_OF_TRUTH"
	| "REPOSITORY_UNAVAILABLE"
	| "REPOSITORY_BASE_UNAVAILABLE"
	| "NOT_REPOSITORY_SOURCED";

function refusal(
	reason: RefusalReason,
	message: string,
): ORPCError<"PRECONDITION_FAILED", { reason: RefusalReason }> {
	return new ORPCError("PRECONDITION_FAILED", {
		message,
		data: { reason },
	});
}

/**
 * `NOTE_REJECTED` (422), naming only the field (spec §5.3). The message never
 * quotes the note: a rejected note may be rejected BECAUSE it carries a
 * credential, and an error body is logged and shown.
 */
function noteRejected(
	field: "title" | "body" | "note",
	message: string,
): ORPCError<
	"UNPROCESSABLE_CONTENT",
	{ reason: "NOTE_REJECTED"; field: string }
> {
	return new ORPCError("UNPROCESSABLE_CONTENT", {
		message,
		data: { reason: "NOTE_REJECTED", field },
	});
}

const FIELD_NAMES = { title: "title", body: "description" } as const;

/**
 * The note, parsed (spec §5.1 step 6), or null when there is none. Only the
 * schema's own messages are used, and each names its field and never the
 * text ("The title is too long").
 */
function parseNote(raw: unknown): ProposalNote | null {
	if (raw === undefined || raw === null) {
		return null;
	}
	if (typeof raw !== "object" || Array.isArray(raw)) {
		return noteThrow(
			"note",
			"The note must be an object with an optional title and description.",
		);
	}
	const parsed = proposalNoteSchema.safeParse(raw);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const field = issue?.path[0] === "body" ? "body" : "title";
		return noteThrow(
			field,
			issue?.message ??
				`The note's ${FIELD_NAMES[field]} is not accepted.`,
		);
	}
	const note: ProposalNote = {
		...(parsed.data.title !== undefined
			? { title: parsed.data.title }
			: {}),
		...(parsed.data.body !== undefined ? { body: parsed.data.body } : {}),
	};
	return note.title === undefined && note.body === undefined ? null : note;
}

function noteThrow(field: "title" | "body" | "note", message: string): never {
	throw noteRejected(field, message);
}

/**
 * A commit message or attribution the renderer refused (Fizzy #2878 §10),
 * 422 naming only the field: the message is the committer's own words and a
 * rejected one may be rejected BECAUSE it carries a credential, so no text is
 * quoted.
 */
export function commitTextRefused(
	code:
		| "MESSAGE_EMPTY"
		| "MESSAGE_TOO_LONG"
		| "MESSAGE_REJECTED"
		| "ATTRIBUTION_REJECTED",
): never {
	const messages = {
		MESSAGE_EMPTY: "The commit message needs a first line.",
		MESSAGE_TOO_LONG: "The commit message is too long.",
		MESSAGE_REJECTED:
			"The commit message looks like it contains a credential. Remove it and try again.",
		ATTRIBUTION_REJECTED:
			"Your name cannot be used as the author of a commit.",
	} as const;
	throw new ORPCError("UNPROCESSABLE_CONTENT", {
		message: messages[code],
		data: {
			reason: code,
			field: code === "ATTRIBUTION_REJECTED" ? "author" : "message",
		},
	});
}

/**
 * The root PR 1's sync froze into the base's `settingsFrozen` (plan R22), or
 * null. Only a string on a non-null object counts, so missing or malformed
 * provenance never equals a sync root and the base is refused.
 */
export function frozenRootPath(value: unknown): string | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const rootPath = (value as { rootPath?: unknown }).rootPath;
	return typeof rootPath === "string" ? rootPath : null;
}

/** ISO 8601 UTC in whole seconds: part of the reproducible commit (spec §5.2). */
export function wholeSecondsNow(): string {
	return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * The project's sync row, its integration and the repository's identity, or
 * the refusal each missing piece earns (spec §5.1 steps 2 to 4). `syncId`
 * names the one row a move into the repository may be admitted against.
 */
async function resolveSyncRepository(
	i: { projectId: string; organizationId: string },
	syncId?: string,
) {
	const sync = await getInstructionRepositorySyncForProposal(
		i.projectId,
		i.organizationId,
	);
	if (
		!sync ||
		sync.organizationId !== i.organizationId ||
		(syncId !== undefined && sync.id !== syncId)
	) {
		throw refusal(
			"REPOSITORY_SOURCE_OF_TRUTH",
			REPOSITORY_SOURCE_OF_TRUTH_MESSAGE,
		);
	}
	const integration = sync.repositoryIntegration;
	if (
		!integration ||
		integration.status !== "ACTIVE" ||
		integration.projectId !== i.projectId
	) {
		throw refusal("REPOSITORY_UNAVAILABLE", REPOSITORY_UNAVAILABLE_MESSAGE);
	}
	const repository = repositoryIdentity(
		integration.provider,
		integration.repositoryUrl,
	);
	if (!repository) {
		throw refusal(
			"REPOSITORY_UNAVAILABLE",
			integration.provider === "AZURE_DEVOPS"
				? ADO_PROJECT_MESSAGE
				: REPOSITORY_UNAVAILABLE_MESSAGE,
		);
	}
	return { sync, repository };
}

/** The note of the move's one pull request and commit (Fizzy #2878 §9): fixed words, never the caller's. */
function migrationNote(): ProposalNote {
	return {
		title: "Move coding instructions into the repository",
		body: "Adds the coding instructions this project had uploaded to Fabric to this folder, in one commit. Once it is merged Fabric syncs the project from this folder instead of from uploads.",
	};
}

/**
 * The admission of a move from uploads into the repository (Fizzy #2878 §9):
 * the REPOSITORY destination of the sync row the move created, with the
 * branch tip the caller read as the commit's base. The project is still
 * upload-backed, so none of the checks that read a published REPOSITORY copy
 * apply; the move is authorized by its procedure (INSTRUCTION_CREATE and
 * INSTRUCTION_UPDATE) rather than by the reader opt-in, and refuses unless
 * the pointer says it is proposing for the row it is admitted against.
 */
async function admitMigration(
	i: AdmissionInput,
	pointer: InstructionMigrationPointer | null,
): Promise<RepositoryAdmission> {
	if (
		pointer === null ||
		pointer.state !== "PROPOSING" ||
		i.baseCommitSha === undefined
	) {
		throw new ORPCError("CONFLICT", {
			message:
				"There is no move of this project's coding instructions into its repository waiting for a pull request.",
			data: { reason: "MIGRATION_NOT_OPEN" },
		});
	}
	const { sync, repository } = await resolveSyncRepository(i, pointer.syncId);
	return renderRepositoryAdmission({
		i,
		sync,
		repository,
		note: migrationNote(),
		baseCommitSha: i.baseCommitSha,
	});
}

/**
 * Spec §5.1 steps 1 to 6. Throws an `ORPCError` whose `data.reason` is one of
 * `REPOSITORY_SOURCE_OF_TRUTH`, `REPOSITORY_UNAVAILABLE`,
 * `REPOSITORY_BASE_UNAVAILABLE` (412) or `NOTE_REJECTED` (422, with
 * `data.field`), or `FORBIDDEN` (403). An attribution the renderer cannot
 * make safe is not a refusal: the row is admitted BLOCKED
 * (`ATTRIBUTION_REJECTED`) and nothing is pushed for it.
 */
export async function admitInstructionProposal(
	i: AdmissionInput,
): Promise<Admission> {
	const settings = await getProjectInstructionSettings(
		i.projectId,
		i.organizationId,
	);
	if (i.mode === "migration") {
		return admitMigration(i, settings.migration);
	}
	// A move into the repository is open (Fizzy #2878 §9): every other way
	// of changing the project's instructions waits for it.
	if (settings.migration) {
		throw await migrationOpenError(settings.migration, {
			projectId: i.projectId,
			organizationId: i.organizationId,
		});
	}
	// A note is a proposal's; any other derivation stores none.
	const note = i.mode === "proposal" ? parseNote(i.note) : null;
	if (settings.sourceOfTruth !== "REPOSITORY") {
		if (i.mode === "commit") {
			throw refusal(
				"NOT_REPOSITORY_SOURCED",
				NOT_REPOSITORY_SOURCED_MESSAGE,
			);
		}
		return { destination: "FABRIC", note };
	}
	if (i.mode !== "proposal" && i.mode !== "commit") {
		throw refusal(
			"REPOSITORY_SOURCE_OF_TRUTH",
			REPOSITORY_SOURCE_OF_TRUTH_MESSAGE,
		);
	}

	const { sync, repository } = await resolveSyncRepository(i);

	await assertRepositoryProposalAccess({
		projectId: i.projectId,
		userId: i.userId,
		// A commit writes the branch itself: the proposal opt-in that lets a
		// reader suggest a pull request never lets one commit.
		allowReaders: i.mode === "commit" ? false : sync.allowReaderProposals,
	});

	// Unscoped pointer read (a project-level pointer), so the tenant is
	// compared here as well as the provenance.
	const base = await getPublishedInstructionSnapshot(i.projectId);
	if (
		!base ||
		base.organizationId !== i.organizationId ||
		base.source !== "REPOSITORY" ||
		!base.sourceCommitSha ||
		base.repositoryIntegrationId !== sync.repositoryIntegrationId ||
		base.sourceRef !== sync.ref ||
		frozenRootPath(base.settingsFrozen) !== sync.rootPath
	) {
		throw refusal(
			"REPOSITORY_BASE_UNAVAILABLE",
			REPOSITORY_BASE_UNAVAILABLE_MESSAGE,
		);
	}

	if (i.mode === "commit") {
		const rendered = renderDirectCommitText({
			message: i.message ?? "",
			proposerName: i.proposerName ?? "",
			mailFrom: config.mails.from,
		});
		if (!rendered.ok) {
			return commitTextRefused(rendered.code);
		}
		return {
			destination: "REPOSITORY_COMMIT",
			note: null,
			context: {
				v: 1,
				integrationId: sync.repositoryIntegrationId,
				syncId: sync.id,
				syncGeneration: sync.generation,
				provider: repository.provider,
				targetRef: sync.ref,
				rootPath: sync.rootPath,
				baseCommitSha: base.sourceCommitSha,
				repository,
				author: rendered.author,
				committer: rendered.committer,
				message: rendered.message,
				committedAt: wholeSecondsNow(),
			},
		};
	}

	return renderRepositoryAdmission({
		i,
		sync,
		repository,
		note,
		baseCommitSha: base.sourceCommitSha,
	});
}

/**
 * A REPOSITORY proposal's frozen destination and rendered text (spec §5.1
 * steps 6 and 7), for the proposal path and for a move into the repository:
 * both freeze the sync row, the repository identity, the base commit and the
 * attribution, and both are admitted BLOCKED when attribution cannot be made
 * safe.
 */
async function renderRepositoryAdmission(args: {
	i: AdmissionInput;
	sync: Awaited<ReturnType<typeof resolveSyncRepository>>["sync"];
	repository: Awaited<ReturnType<typeof resolveSyncRepository>>["repository"];
	note: ProposalNote | null;
	baseCommitSha: string;
}): Promise<RepositoryAdmission> {
	const { i, sync, repository, note, baseCommitSha } = args;
	const project = await db.project.findFirst({
		where: { id: i.projectId, organizationId: i.organizationId },
		select: { name: true },
	});
	const text = renderPullRequestText({
		note: note ?? {},
		proposerName: i.proposerName ?? "",
		projectName: project?.name ?? "",
		fileCount: i.fileCount,
		mailFrom: config.mails.from,
	});
	if (!text.ok && text.code === "NOTE_REJECTED") {
		throw noteRejected(
			text.field,
			`The note's ${FIELD_NAMES[text.field]} looks like it contains a credential. Remove it and try again.`,
		);
	}

	const operationId = createId();
	const committedAt = wholeSecondsNow();
	const shared = {
		v: 2 as const,
		integrationId: sync.repositoryIntegrationId,
		syncId: sync.id,
		syncGeneration: sync.generation,
		provider: repository.provider,
		targetRef: sync.ref,
		rootPath: sync.rootPath,
		baseCommitSha,
		repository,
		committedAt,
	};
	if (!text.ok) {
		// Admitted BLOCKED (spec §5.2 step 4): nothing is ever pushed for this
		// row, so no attribution or text is frozen as though it were usable.
		const unattributed = {
			name: FALLBACK_PROPOSER_NAME,
			email: "unattributed",
		};
		return {
			destination: "REPOSITORY",
			note,
			operationId,
			syncId: sync.id,
			syncGeneration: sync.generation,
			context: {
				...shared,
				author: unattributed,
				committer: {
					name: PULL_REQUEST_COMMITTER_NAME,
					email: "unattributed",
				},
				message: "",
			},
			blocked: {
				phase: "admission",
				code: "ATTRIBUTION_REJECTED",
				retryable: false,
				at: new Date().toISOString(),
				params: {},
			},
		};
	}
	return {
		destination: "REPOSITORY",
		note,
		operationId,
		syncId: sync.id,
		syncGeneration: sync.generation,
		context: {
			...shared,
			author: text.author,
			committer: text.committer,
			message: text.message,
		},
	};
}

/**
 * The caller-known half of a REPOSITORY proposal's `upload_started` row
 * (plan Decision 11): the request's actor and plain request fields, plus the
 * metadata the caller knows. The create transaction adds the snapshot's id,
 * `v<version>` and the creation counts, and writes the row with the snapshot.
 */
export function uploadStartedAuditTemplate(
	context: AuditRequestContext,
	i: {
		organizationId: string;
		projectId: string;
		baseSnapshotId: string;
		baseVersion: number;
		putCount: number;
		deleteCount: number;
		via?: string;
	},
): UploadStartedAuditTemplate {
	const fields = auditRequestFields(context);
	return {
		actor: resolveActor(context, undefined),
		organizationId: i.organizationId,
		projectId: i.projectId,
		ipAddress: fields.ipAddress,
		userAgent: fields.userAgent,
		requestId: fields.requestId,
		sessionId: fields.sessionId,
		correlationId: fields.correlationId,
		metadata: {
			mode: "proposal",
			baseSnapshotId: i.baseSnapshotId,
			baseVersion: i.baseVersion,
			putCount: i.putCount,
			deleteCount: i.deleteCount,
			...(i.via !== undefined ? { via: i.via } : {}),
		},
	};
}

/** The REPOSITORY half of `createDerivedInstructionSnapshot`'s input. */
export function repositoryDestination(
	admission: RepositoryAdmission,
	uploadStartedAudit: UploadStartedAuditTemplate,
): RepositoryProposalDestination {
	return {
		kind: "REPOSITORY",
		operationId: admission.operationId,
		context: admission.context,
		syncId: admission.syncId,
		syncGeneration: admission.syncGeneration,
		...(admission.blocked ? { blocked: admission.blocked } : {}),
		uploadStartedAudit,
	};
}
