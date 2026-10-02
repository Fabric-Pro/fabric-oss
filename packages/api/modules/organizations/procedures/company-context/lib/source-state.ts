/**
 * What each company source's state means for retrieval (Fizzy #2719): ready,
 * in flight, or in need of re-processing because the organization's embedding
 * model has changed since it was embedded.
 *
 * "Ready" is never decided here. It is `companyContextReadyWhere` — the one
 * predicate the page, the empty-context notice and retrieval all read —
 * evaluated with the organization's current model. This module only resolves
 * that model and labels each source against the ready set.
 */

import { AIProviderNotConfiguredError } from "@repo/ai";
import { db, listReadyCompanyContextSourceIds } from "@repo/database";
import {
	type CompanyEmbeddingModel,
	resolveCompanyEmbeddingModel,
	UNSUPPORTED_EMBEDDING_MODEL_REASON,
} from "@repo/rag";

/**
 * The organization's current embedding model, or null when no embedding
 * provider resolves — then nothing can be embedded, and nothing is ready.
 *
 * `userId` is the acting user, passed through to the resolver as the vector
 * contract requires.
 */
export async function resolveCurrentCompanyModel(
	organizationId: string,
	userId: string,
): Promise<CompanyEmbeddingModel | null> {
	try {
		return await resolveCompanyEmbeddingModel({ organizationId, userId });
	} catch (error) {
		if (error instanceof AIProviderNotConfiguredError) {
			return null;
		}
		throw error;
	}
}

/** The source fields the in-flight decision reads. */
interface CompanySourceProgressFields {
	extractionStatus: string;
	urlActiveWorkflowId: string | null;
}

/**
 * True while a source is being processed: its extraction, embedding or crawl
 * is queued or running (PENDING or EXTRACTING), or — for a website — a crawl
 * holds its slot. Every company crawl claims that slot, a scheduled refresh
 * included, and a scheduled refresh leaves the status COMPLETED, so the slot
 * is what tells one apart from an idle source.
 */
export function isCompanySourceInFlight(
	source: CompanySourceProgressFields,
): boolean {
	return (
		source.urlActiveWorkflowId !== null ||
		source.extractionStatus === "PENDING" ||
		source.extractionStatus === "EXTRACTING"
	);
}

/**
 * The ready set and the model mismatches the re-processing decision reads,
 * evaluated under one model.
 */
interface CompanySourceIndexState {
	/** Sources ready for retrieval under the current model. */
	readyIds: ReadonlySet<string>;
	/**
	 * Website sources holding a crawled page whose vectors came from another
	 * model than the current one.
	 */
	otherModelPageSourceIds: ReadonlySet<string>;
}

const EMPTY_INDEX_STATE: CompanySourceIndexState = {
	readyIds: new Set(),
	otherModelPageSourceIds: new Set(),
};

/** Ids of the organization's sources ready under `model`. */
async function readyCompanySourceIds(
	organizationId: string,
	model: CompanyEmbeddingModel,
): Promise<Set<string>> {
	return new Set(
		await listReadyCompanyContextSourceIds(organizationId, model.identity),
	);
}

/**
 * Ids of the organization's website sources with at least one crawled page
 * embedded by another model than `identity`. A page with vectors but no
 * recorded model counts: it cannot be matched to the current one either.
 */
async function sourcesWithPagesFromOtherModels(
	organizationId: string,
	identity: string,
): Promise<Set<string>> {
	const pages = await db.companyContextUrlPage.findMany({
		where: {
			organizationId,
			embeddedAt: { not: null },
			OR: [
				{ embeddingModel: null },
				{ embeddingModel: { not: identity } },
			],
		},
		select: { parentSourceId: true },
		distinct: ["parentSourceId"],
	});
	return new Set(pages.map((page) => page.parentSourceId));
}

/**
 * The organization's index state under `model`: which sources are ready, and
 * which websites hold pages from another model. Empty without a model, or
 * under one whose vectors cannot be stored — nothing is ready then, and
 * nothing is offered for re-processing.
 */
export async function loadCompanySourceIndexState(
	organizationId: string,
	model: CompanyEmbeddingModel | null,
): Promise<CompanySourceIndexState> {
	if (!model) {
		return EMPTY_INDEX_STATE;
	}
	const [readyIds, otherModelPageSourceIds] = await Promise.all([
		readyCompanySourceIds(organizationId, model),
		model.supported
			? sourcesWithPagesFromOtherModels(organizationId, model.identity)
			: Promise.resolve(new Set<string>()),
	]);
	return { readyIds, otherModelPageSourceIds };
}

/** The fields the re-processing decision reads. */
interface CompanySourceStateFields extends CompanySourceProgressFields {
	id: string;
	extractionError: string | null;
	embeddingModel: string | null;
	deletingAt: Date | null;
}

/**
 * True once a delete of the source has started (its tombstone is set). It
 * stays listed until the deletion workflow removes the row, but nothing new
 * may start on it — the only action left is deleting it again.
 */
export function isCompanySourceDeleting(source: {
	deletingAt: Date | null;
}): boolean {
	return source.deletingAt !== null;
}

/**
 * Whether a source needs re-processing to become ready again, because its
 * vectors do not match the organization's current embedding model: the
 * source was embedded with another model, one of its crawled pages was, or
 * it was refused an earlier model that could not be stored. Only meaningful
 * while the current model can be stored — under an unsupported one,
 * re-processing would fail again.
 *
 * "Not ready" alone is not a reason. A source still processing — a scheduled
 * refresh adding a page included — or one that failed for another reason
 * already says what is wrong, and re-processing it would only start a second
 * run beside the first. A source being deleted is never offered: it is going,
 * and the re-processing claim refuses it anyway.
 */
export function needsCompanySourceReprocessing(
	source: CompanySourceStateFields,
	state: CompanySourceIndexState,
	model: CompanyEmbeddingModel | null,
): boolean {
	if (
		!model?.supported ||
		isCompanySourceDeleting(source) ||
		state.readyIds.has(source.id) ||
		isCompanySourceInFlight(source)
	) {
		return false;
	}
	if (
		source.embeddingModel !== null &&
		source.embeddingModel !== model.identity
	) {
		return true;
	}
	if (state.otherModelPageSourceIds.has(source.id)) {
		return true;
	}
	return (
		source.extractionStatus === "FAILED" &&
		(source.extractionError?.startsWith(
			UNSUPPORTED_EMBEDDING_MODEL_REASON,
		) ??
			false)
	);
}

/** The current model as the page shows it. */
export function describeCompanyModel(
	model: CompanyEmbeddingModel | null,
): { identity: string; supported: boolean } | null {
	return model
		? { identity: model.identity, supported: model.supported }
		: null;
}
