/**
 * The documents a paused document batch or project setup hands to its resume
 * (Fizzy #2770), read from and taken out of its saved state. Pure, so the
 * pause activity and "Run now" read the state the same way.
 *
 * A batch resumes the documents on its input; a setup resumes the documents
 * on its progress it has not finished. Only those the run still holds are
 * resumed (Fizzy #2946): a person's save over a stalled run completed one, or
 * a newer generation owns it.
 */

import type { BulkRunKind, BulkRunResumeState } from "./bulk-run-pause";

type SavedRun = Pick<BulkRunResumeState, "input" | "progress">;

interface SetupProgress {
	documents?: Array<{ id: string }>;
	finishedDocumentIds?: string[];
}

function setupProgress(progress: unknown): SetupProgress | null {
	return typeof progress === "object" && progress !== null
		? (progress as SetupProgress)
		: null;
}

/** The documents the run's resume would generate; none for other kinds. */
export function bulkRunResumeDocumentIds(
	kind: BulkRunKind,
	saved: SavedRun,
): string[] {
	if (kind === "DOCUMENT_BATCH") {
		const documents = saved.input.documents;
		return Array.isArray(documents)
			? documents.map((doc: { id: string }) => doc.id)
			: [];
	}
	const progress =
		kind === "PROJECT_SETUP" ? setupProgress(saved.progress) : null;
	const documents = progress?.documents;
	if (!progress || !Array.isArray(documents)) {
		return [];
	}
	const finished = new Set(progress.finishedDocumentIds ?? []);
	return documents.map((doc) => doc.id).filter((id) => !finished.has(id));
}

/**
 * The saved state without `released`, so the resume, scheduled or Run now,
 * never generates them: a batch drops them from its input, a setup counts
 * them finished ("ended either way: never generated again").
 */
export function withoutResumeDocuments(
	kind: BulkRunKind,
	saved: SavedRun,
	released: ReadonlySet<string>,
): SavedRun {
	if (released.size === 0) {
		return saved;
	}
	const documents = saved.input.documents;
	if (kind === "DOCUMENT_BATCH" && Array.isArray(documents)) {
		return {
			...saved,
			input: {
				...saved.input,
				documents: documents.filter(
					(doc: { id: string }) => !released.has(doc.id),
				),
			},
		};
	}
	const progress = kind === "PROJECT_SETUP" && setupProgress(saved.progress);
	if (progress) {
		const finished = progress.finishedDocumentIds ?? [];
		return {
			...saved,
			progress: {
				...progress,
				finishedDocumentIds: [
					...finished,
					...[...released].filter((id) => !finished.includes(id)),
				],
			},
		};
	}
	return saved;
}
