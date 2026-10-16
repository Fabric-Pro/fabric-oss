/**
 * The write folders, from the server or from the lock's last copy.
 *
 * A push at the end of every turn must cost nothing when nothing changed, so
 * it may use the folders the lock remembers; a pull and a status always ask,
 * which keeps that copy fresh.
 */
import type { MemoryWriteTarget } from "@fabricorg/sdk";
import type { MirrorContext } from "./context.js";
import type { MemoryLock } from "./lock.js";

export async function loadTargets(
	context: MirrorContext,
	lock: MemoryLock,
	options: { cached?: boolean } = {},
): Promise<MemoryWriteTarget[]> {
	if (options.cached && lock.targets !== undefined) {
		return lock.targets;
	}
	const { targets } = await context.client.memory.getTargets(
		context.projectId,
	);
	lock.targets = targets;
	return targets;
}
