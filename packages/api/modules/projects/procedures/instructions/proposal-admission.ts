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
 * root, the base commit, the repository identity and the rendered outbound
 * text — and creation-side steps later check the configuration still equals
 * it rather than re-resolving it. Direct derives and publish mode keep the
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
	type PullRequestFailure,
	type RepositoryProposalDestination,
	type UploadStartedAuditTemplate,
} from "@repo/database";
import {
	FALLBACK_PROPOSER_NAME,
	type ProposalNote,
	PULL_REQUEST_COMMITTER_NAME,
	type PullRequestContext,
	proposalNoteSchema,
	renderPullRequestText,
} from "@repo/instructions";
import { repositoryIdentity } from "@repo/integrations/instruction-pull-requests";
import {
	type AuditRequestContext,
	auditRequestFields,
	resolveActor,
} from "../../../../lib/audit";
import { assertRepositoryProposalAccess } from "./proposal-authorization";

/**
 * What the caller is asking for. `proposal` is the reviewed path; `publish`
 * is the inline entry point's unreviewed one and `direct` the tab's direct
 * save. Only a proposal can reach a REPOSITORY destination.
 */
type AdmissionMode = "proposal" | "publish" | "direct";

export type AdmissionInput = {
	projectId: string;
	/** The project's hosting organization, already resolved server-side. */
	organizationId: string;
	userId: string;
	mode: AdmissionMode;
	/** The raw `note` from the request; parsed here with `proposalNoteSchema`. */
	note?: unknown;
	/** The proposer's display name, a body input only (spec §5.2). */
	proposerName: string | null | undefined;
	/** How many paths the change set touches, for the default title. */
	fileCount: number;
};

export type RepositoryAdmission = {
	destination: "REPOSITORY";
	note: ProposalNote | null;
	operationId: string;
	context: PullRequestContext;
	syncId: string;
	syncGeneration: number;
	/** Attribution refused at admission: the row is admitted BLOCKED and nothing is pushed. */
	blocked?: PullRequestFailure;
};

export type Admission =
	| { destination: "FABRIC"; note: ProposalNote | null }
	| RepositoryAdmission;

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

type RefusalReason =
	| "REPOSITORY_SOURCE_OF_TRUTH"
	| "REPOSITORY_UNAVAILABLE"
	| "REPOSITORY_BASE_UNAVAILABLE";

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
function wholeSecondsNow(): string {
	return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The operation's attempt-1 branch (spec §2.7). */
function operationBranch(operationId: string): string {
	return `fabric/instructions/${operationId}`;
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
	// A note is a proposal's; any other derivation stores none.
	const note = i.mode === "proposal" ? parseNote(i.note) : null;
	if (settings.sourceOfTruth !== "REPOSITORY") {
		return { destination: "FABRIC", note };
	}
	if (i.mode !== "proposal") {
		throw refusal(
			"REPOSITORY_SOURCE_OF_TRUTH",
			REPOSITORY_SOURCE_OF_TRUTH_MESSAGE,
		);
	}

	const sync = await getInstructionRepositorySyncForProposal(
		i.projectId,
		i.organizationId,
	);
	if (!sync || sync.organizationId !== i.organizationId) {
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

	await assertRepositoryProposalAccess({
		projectId: i.projectId,
		userId: i.userId,
		allowReaders: sync.allowReaderProposals,
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
		v: 1 as const,
		integrationId: sync.repositoryIntegrationId,
		syncId: sync.id,
		syncGeneration: sync.generation,
		provider: repository.provider,
		targetRef: sync.ref,
		rootPath: sync.rootPath,
		baseCommitSha: base.sourceCommitSha,
		repository,
		branch: operationBranch(operationId),
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
				title: "",
				body: "",
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
			title: text.title,
			body: text.body,
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
		branch: admission.context.branch,
		...(admission.blocked ? { blocked: admission.blocked } : {}),
		uploadStartedAudit,
	};
}
