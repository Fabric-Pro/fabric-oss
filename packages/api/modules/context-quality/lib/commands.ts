import {
	CONTEXT_QUALITY_MAX_BYTES,
	evaluateContextQuality,
} from "@repo/rag/lib/context-quality";
import { projectContextEvaluationSchema } from "../contracts";
import {
	ContextReadError,
	type ProjectContextSnapshot,
	readProjectContextSnapshot,
} from "./context-reader";

export interface ContextQualityActor {
	organizationId: string;
	projectId: string;
	userId: string;
}

export class ContextQualityInputError extends Error {
	constructor() {
		super(
			"Use a valid bounded evaluation with source revisions, recorded answers and expectations.",
		);
		this.name = "ContextQualityInputError";
	}
}

export async function inspectContextQualitySource(
	actor: ContextQualityActor,
	sourceId: string,
) {
	return readProjectContextSnapshot({ ...actor, sourceId });
}

/**
 * Bounded synchronous recorded-output scoring. No target, model or retrieval is
 * invoked and no snapshot is persisted/exported. Each read uses current access;
 * pins fence changes between inspection, loading and returning the result.
 */
export async function evaluateProjectContext(
	actor: ContextQualityActor,
	rawInput: unknown,
) {
	const parsed = projectContextEvaluationSchema.safeParse(rawInput);
	if (!parsed.success) {
		throw new ContextQualityInputError();
	}
	const input = parsed.data;
	const sources: ProjectContextSnapshot[] = [];
	let sourceBytes = 0;
	for (const reference of input.sources) {
		const source = await readProjectContextSnapshot({
			...actor,
			...reference,
		});
		sourceBytes += source.byteLength;
		if (sourceBytes > CONTEXT_QUALITY_MAX_BYTES) {
			throw new ContextReadError("TOO_LARGE");
		}
		sources.push(source);
	}
	let result: ReturnType<typeof evaluateContextQuality>;
	const snapshot = {
		version: input.version,
		sources: sources.map((source) => ({
			id: source.sourceId,
			revision: source.revision,
			content: source.content,
		})),
		cases: input.cases,
	};
	// JSON escaping and case overhead count too: valid source/request sizes do
	// not imply their combined scoring snapshot fits the processing budget.
	if (
		Buffer.byteLength(JSON.stringify(snapshot), "utf8") >
		CONTEXT_QUALITY_MAX_BYTES
	) {
		throw new ContextReadError("TOO_LARGE");
	}
	try {
		result = evaluateContextQuality(snapshot);
	} catch {
		// Validation failures must not echo submitted answers or source bytes.
		throw new ContextQualityInputError();
	}
	// A previous source may have changed or been erased while a later one loaded.
	// Re-read all pins under current permission before releasing any result.
	for (const reference of input.sources) {
		await readProjectContextSnapshot({ ...actor, ...reference });
	}
	return {
		...result,
		projectId: actor.projectId,
		organizationId: actor.organizationId,
	};
}
