import type { TaskDefaultsSnapshot } from "../../prisma/queries/task-default-snapshots";

export function snapshotFixture(
	scoped: Partial<TaskDefaultsSnapshot["scoped"]> = {},
	unscoped: Partial<TaskDefaultsSnapshot["unscoped"]> = scoped,
): TaskDefaultsSnapshot {
	const empty = {
		SIMPLE: null,
		COMPLEX: null,
		REASONING: null,
		CHAT: null,
		TOOL_CALLING: null,
		EVAL: null,
	};
	return {
		version: 1,
		capturedAt: "2026-10-21T00:00:00.000Z",
		scoped: { ...empty, ...scoped },
		unscoped: { ...empty, ...unscoped },
	};
}
