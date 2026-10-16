/**
 * What the memory mirror runs against: the SDK client, the project and root it
 * mirrors, and the git operations it needs. All of it is injected, so the
 * engine runs against a temp directory and a temp repository in tests.
 */
import type { FabricClient } from "@fabricorg/sdk";

const FETCH_CONCURRENCY = 4;

export interface MirrorGit {
	/** The paths under `folders` that git tracks, or `null` when git cannot say. */
	tracked(folders: readonly string[]): Promise<Set<string> | null>;
	/** Keep these paths (relative to the root) out of the developer's commits. */
	exclude(paths: readonly string[]): Promise<void>;
}

export interface MirrorContext {
	client: Pick<FabricClient, "memory">;
	projectId: string;
	/** The canonical root files are mirrored under. */
	root: string;
	git: MirrorGit;
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
	now?: () => Date;
}

export function now(context: MirrorContext): Date {
	return context.now?.() ?? new Date();
}

/** Throws when the run's deadline has passed, so a hook never overruns it. */
export function aborted(context: MirrorContext): void {
	if (context.signal?.aborted) {
		throw context.signal.reason instanceof Error
			? context.signal.reason
			: new Error("The deadline passed.");
	}
}

export async function inParallel<T>(
	items: readonly T[],
	work: (item: T) => Promise<void>,
): Promise<void> {
	const queue = items.values();
	const worker = async () => {
		for (;;) {
			const next = queue.next();
			if (next.done) {
				return;
			}
			await work(next.value);
		}
	};
	await Promise.all(
		Array.from(
			{ length: Math.min(FETCH_CONCURRENCY, items.length) },
			worker,
		),
	);
}
