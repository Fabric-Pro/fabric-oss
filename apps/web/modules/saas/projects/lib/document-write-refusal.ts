import { DOCUMENT_SAVE_BASE_REQUIRED } from "@repo/utils/document-save-base";
import {
	DOCUMENT_GENERATION_IN_PROGRESS,
	DOCUMENT_STATUS_GENERATION_OWNED,
} from "@repo/utils/generation-run-guard";
import type { useTranslations } from "next-intl";
import { getOrpcCode } from "../components/field-mapping/orpc-error";
import { getOrpcErrorData } from "./orpc-error-data";

/**
 * Why the server refused a document write, in words the reader can act on
 * (Fizzy #2946). Restores, Update using context, the documents list and the
 * editor's fallbacks used to show the server's English message; the refusal
 * codes they can meet are mapped here once, so every surface says the same
 * thing in the reader's locale.
 */

type Translate = ReturnType<typeof useTranslations>;

/** Which refusal it was, for a caller that also changes what it shows. */
export type DocumentWriteRefusalKind =
	| "runLive"
	| "changedMeanwhile"
	| "baseRequired"
	| "statusGenerationOwned"
	| "failed";

/** The refusal's kind; `failed` for anything this module does not name. */
export function documentWriteRefusalKind(
	error: unknown,
): DocumentWriteRefusalKind {
	const code = getOrpcCode(error);
	const dataCode = getOrpcErrorData(error).code;
	if (code === "CONFLICT" && dataCode === DOCUMENT_GENERATION_IN_PROGRESS) {
		return "runLive";
	}
	if (
		code === "PRECONDITION_FAILED" &&
		dataCode === DOCUMENT_SAVE_BASE_REQUIRED
	) {
		return "baseRequired";
	}
	if (
		code === "BAD_REQUEST" &&
		dataCode === DOCUMENT_STATUS_GENERATION_OWNED
	) {
		return "statusGenerationOwned";
	}
	if (code === "CONFLICT") {
		return "changedMeanwhile";
	}
	return "failed";
}

/**
 * The sentence to show for a refused write, from the
 * `projects.documentWriteRefusal` translator. Never the server's words.
 */
export function describeDocumentWriteRefusal(
	error: unknown,
	t: Translate,
): { kind: DocumentWriteRefusalKind; message: string } {
	const kind = documentWriteRefusalKind(error);
	return { kind, message: t(kind) };
}
