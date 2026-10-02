/**
 * The seam between the shared context-source forms and whoever owns the
 * sources.
 *
 * The File, Link and Text tab bodies and the source-details dialog know how to
 * collect, validate and report a submission; they do not know whose sources
 * they are adding to. An owner — a project today, the organization's company
 * context next — supplies an adapter that turns each submission into its own
 * procedure call, adding its identifiers (a project id, an organization id)
 * around the payload. Everything the owner alone cares about (telemetry,
 * extra fields such as "Tag as Document") stays with the owner.
 */

import type { KnowledgeBaseSourceCategoryValue } from "@repo/api/modules/projects/procedures/contexts/knowledge-base-category.types";
import type { QueryKey } from "@tanstack/react-query";
import type { UrlRefreshMode, UrlScope } from "./url-source";

/**
 * One link as the Link tab submits it — a single URL, or one line of a bulk
 * paste. Optional fields are omitted entirely when unset, never sent empty.
 */
export interface LinkSourceSubmission {
	url: string;
	label?: string;
	scope: UrlScope;
	refreshMode: UrlRefreshMode;
	maxPages?: number;
	knowledgeBaseSourceCategory?: KnowledgeBaseSourceCategoryValue;
	knowledgeBaseSourceCategoryOther?: string;
	sourceType?: string;
	aiInstructions?: string;
}

/** What the add forms call. */
export interface ContextSourceSubmitAdapter {
	/**
	 * Reserve a source row for a file and hand back where to PUT its bytes.
	 * Resolves only with a URL the browser can upload to; an owner whose
	 * storage cannot presign throws its own message instead.
	 */
	createUploadUrl: (file: {
		filename: string;
		mimeType: string;
		size: number;
	}) => Promise<{
		signedUploadUrl: string;
		contextId: string;
		/** The type the server resolved, sent as the PUT's Content-Type. */
		contentType?: string | null;
	}>;
	/** Start extraction for a file whose bytes have been uploaded. */
	processFile: (input: { contextId: string }) => Promise<unknown>;
	processLink: (link: LinkSourceSubmission) => Promise<unknown>;
	createText: (text: { title: string; content: string }) => Promise<unknown>;
	/** The owner's source list, invalidated once anything has been added. */
	listQueryKey: QueryKey;
}

/**
 * A source the forms added. Reported once per successful row — N files or N
 * pasted URLs report N times — so an owner can count what was attached.
 */
export type ContextSourceAdded =
	| { contextType: "FILE" }
	| { contextType: "TEXT" }
	| {
			contextType: "LINK";
			scope: UrlScope;
			refreshMode: UrlRefreshMode;
			maxPages: number | null;
	  };

/** A source's type label and AI instructions (Fizzy #1888). */
export interface ContextSourceMetadata {
	sourceType: string | null;
	aiInstructions: string | null;
}

/** What a metadata save returns. */
export interface SavedContextSourceMetadata extends ContextSourceMetadata {
	contextId: string;
	metadataUpdatedAt?: Date | string | null;
	metadataUpdatedByUserId?: string | null;
}

/** What the source-details dialog calls. */
export interface ContextSourceDetailsAdapter {
	/**
	 * Save a source's metadata. `expected` is the version the user started
	 * from; a save that finds anything else stored must reject with
	 * `{ code: "CONFLICT", data: { current } }` rather than overwrite it.
	 */
	saveMetadata: (
		input: ContextSourceMetadata & {
			contextId: string;
			expected: ContextSourceMetadata;
		},
	) => Promise<SavedContextSourceMetadata>;
	/** The list the saved row is written into and then refetched. */
	listQueryKey: QueryKey;
	/**
	 * A hook resolving the display name of whoever last edited a source, or
	 * null when unknown or still loading. Called only while the dialog shows
	 * a "last edited" line, so its lookup never runs on a list's hot path.
	 */
	useEditorName: (userId: string | null) => string | null;
}
