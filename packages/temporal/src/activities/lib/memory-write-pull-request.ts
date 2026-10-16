/**
 * The pull request a Living Memory write opens (ADR-022): its title and
 * description, and the provider call that opens it once.
 *
 * Title: the message's subject. Body: the message's body, the files the write
 * changes, and a footer naming the member the write acts for. Both go through
 * the escaping every Fabric pull request text does (`escapeMarkdown`, then
 * `neutraliseMentions` first): the message is an agent's, and an `@name` in it
 * must not page anyone from the repository under Fabric's identity. The
 * message was scanned for credentials when it was admitted and rendered.
 *
 * Opening is idempotent. The branch is named by the write, so a pull request
 * from it is the write's; a lookup before the open, and a lookup after a
 * provider that answers "already exists", find the one an earlier attempt
 * opened instead of opening a second.
 *
 * Not re-exported from the activities barrel: every export of a module the
 * barrel re-exports becomes a schedulable Temporal activity.
 */
import {
	escapeMarkdown,
	neutraliseMentions,
} from "@repo/instructions/pull-request-text";
import {
	InstructionPullRequestError,
	type PullRequestObservation,
} from "@repo/integrations/instruction-pull-requests";
import type { BranchCredential } from "./instruction-branch-credential";
import { ProposalStepFailure } from "./instruction-proposal-boundary";
import { providerCall } from "./instruction-proposal-operation";

/** The most files listed in a description; the write names at most 50 anyway. */
const MAX_LISTED_FILES = 50;

const FILE_VERBS = { PUT: "Writes", DELETE: "Deletes" } as const;

/** The title and description of a write's pull request. */
export function renderMemoryWritePullRequest(input: {
	subject: string;
	body: string;
	authorName: string;
	files: ReadonlyArray<{ path: string; op: "PUT" | "DELETE" }>;
}): { title: string; body: string } {
	const listed = input.files
		.slice(0, MAX_LISTED_FILES)
		.map((file) => `- ${FILE_VERBS[file.op]} ${file.path}`);
	const files = [
		input.files.length === 1 ? "1 file:" : `${input.files.length} files:`,
		...listed,
	].join("\n");
	const footer = `Opened from Fabric by ${input.authorName}`;
	const body = [
		...(input.body === "" ? [] : [input.body]),
		files,
		"---",
		footer,
	].join("\n\n");
	return {
		title: escapeMarkdown(neutraliseMentions(input.subject)),
		body: escapeMarkdown(neutraliseMentions(body)),
	};
}

function lookupInconclusive(): ProposalStepFailure {
	return new ProposalStepFailure({
		code: "LOOKUP_INCONCLUSIVE",
		phase: "create",
		retryable: true,
	});
}

/**
 * The pull request from `sourceRef`, opened now or found because an earlier
 * attempt opened it. A lookup that cannot decide is a retryable failure: the
 * next attempt looks again before it opens anything.
 */
export async function openMemoryWritePullRequest(input: {
	credential: BranchCredential;
	sourceRef: string;
	targetRef: string;
	title: string;
	body: string;
}): Promise<PullRequestObservation> {
	const { credential } = input;
	const { adapter, target } = credential;
	const find = async (): Promise<PullRequestObservation | null> => {
		const found = await adapter.findOperation({
			...target,
			sourceRef: input.sourceRef,
		});
		if (found.kind === "FOUND") {
			return found.value;
		}
		if (found.kind === "INCONCLUSIVE") {
			throw lookupInconclusive();
		}
		return null;
	};
	return providerCall("create", credential, async () => {
		const existing = await find();
		if (existing !== null) {
			return existing;
		}
		try {
			return await adapter.open({
				...target,
				sourceRef: input.sourceRef,
				targetRef: input.targetRef,
				title: input.title,
				body: input.body,
			});
		} catch (error) {
			if (
				error instanceof InstructionPullRequestError &&
				error.duplicate
			) {
				const raced = await find();
				if (raced !== null) {
					return raced;
				}
			}
			throw error;
		}
	});
}
