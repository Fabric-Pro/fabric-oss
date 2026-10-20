/**
 * What one Proposal export reads (Fizzy #2946), and the access check that
 * comes first. Not an activity of its own: the export activity calls it.
 *
 * Only ids travel to the worker, and access may have changed since the
 * export was requested, so this checks again, in the worker, everything the
 * procedure checked: the project still belongs to the organization the
 * procedure resolved and is not in the trash, the document still belongs to
 * the project, the starter can still reach the project, and the document is
 * still a client-document Proposal. Any failure is the same non-retryable
 * `EXPORT_ACCESS_DENIED`, which names nothing.
 *
 * A project guest exports the same client document as a member, so the brand
 * is read through the guest-safe resolver for everyone: style direction and
 * Brand kit guidance never reach the worker.
 *
 * The title and the parties' names are printed on the cover and written
 * into the file's properties, so, like Main's text, they lose any storage
 * reference written into them.
 */

import {
	db,
	hasProjectAccess,
	isProposalClientDocument,
	resolveGuestSafeProposalThemeTokens,
} from "@repo/database";
import type {
	ProposalThemeTokens,
	SourcedValue,
} from "@repo/utils/proposal-artifact/theme-tokens";
import { withoutStorageReferences } from "../../lib/proposal-export/document-content";
import { exportFailure } from "../../lib/proposal-export/failures";
import type { ProposalExportWorkflowInput } from "../../lib/proposal-export/types";

export interface ProposalExportInput {
	title: string;
	/** Main, as stored; scrubbed and parsed later. */
	content: string;
	/** Guest-safe brand tokens; assets are still storage references. */
	tokens: ProposalThemeTokens;
}

/** Load the document and its brand, or refuse with `EXPORT_ACCESS_DENIED`. */
export async function loadExportInput(
	input: ProposalExportWorkflowInput,
): Promise<ProposalExportInput> {
	const [project, document] = await Promise.all([
		db.project.findUnique({
			where: { id: input.projectId },
			select: { organizationId: true, deletedAt: true },
		}),
		db.projectDocument.findFirst({
			where: { id: input.documentId, projectId: input.projectId },
			select: { id: true, type: true, title: true, content: true },
		}),
	]);
	if (
		!project ||
		project.deletedAt ||
		project.organizationId !== input.organizationId
	) {
		throw exportFailure("EXPORT_ACCESS_DENIED");
	}
	if (!document) {
		throw exportFailure("EXPORT_ACCESS_DENIED");
	}

	const [canRead, isClientDocument] = await Promise.all([
		hasProjectAccess(input.projectId, input.userId),
		isProposalClientDocument({
			organizationId: input.organizationId,
			documentType: document.type,
		}),
	]);
	if (!canRead || !isClientDocument) {
		throw exportFailure("EXPORT_ACCESS_DENIED");
	}

	const tokens = await resolveGuestSafeProposalThemeTokens({
		organizationId: input.organizationId,
		projectId: input.projectId,
		documentId: document.id,
	});
	return {
		title:
			withoutStorageReferences(document.title ?? "").trim() || "Proposal",
		content: document.content ?? "",
		tokens: {
			...tokens,
			proposer: {
				...tokens.proposer,
				name: printableName(tokens.proposer.name),
			},
			recipient: {
				...tokens.recipient,
				name: printableName(tokens.recipient.name),
			},
		},
	};
}

/** A party's name without storage references, or null when none is left. */
function printableName(
	name: SourcedValue<string | null>,
): SourcedValue<string | null> {
	if (name.value === null) {
		return name;
	}
	const value = withoutStorageReferences(name.value).trim();
	return { ...name, value: value === "" ? null : value };
}

/**
 * The date the cover and footer print, in the reader-facing long form, in
 * UTC so a retry on another worker prints the same day.
 */
export function exportDateLabel(now: Date): string {
	return new Intl.DateTimeFormat("en-US", {
		dateStyle: "long",
		timeZone: "UTC",
	}).format(now);
}
