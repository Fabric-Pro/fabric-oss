import { createHash } from "node:crypto";
import type { DirectInstructionRepositoryFile } from "@fabricorg/sdk";
import { findCollision } from "./paths.js";
import {
	assertPushablePath,
	MAX_INLINE_PUSH_BYTES,
	MAX_PUSH_CHANGES,
	type PushPlan,
	type PushPlanEntry,
} from "./push.js";
import { readFileSafely } from "./safe-write.js";

export async function computeNativePushPlan(input: {
	root: string;
	files: readonly DirectInstructionRepositoryFile[];
	changedPaths: readonly string[];
	added?: readonly string[];
}): Promise<PushPlan> {
	const allowed = new Set(input.files.map((file) => file.path));
	const selected = new Set(
		input.changedPaths.filter((file) => allowed.has(file)),
	);
	for (const file of input.added ?? []) {
		assertPushablePath(file, "That path cannot be pushed.");
		// Naming an existing, unchanged file must not create a phantom edit.
		if (!allowed.has(file)) selected.add(file);
	}
	if (selected.size > MAX_PUSH_CHANGES) {
		throw new Error(
			`Too many changes to push (${selected.size} > ${MAX_PUSH_CHANGES}). Select a smaller change set.`,
		);
	}
	const collision = findCollision([...new Set([...allowed, ...selected])]);
	if (collision !== null) {
		throw new Error(
			`Refusing to push colliding paths: ${collision.first} and ${collision.second}.`,
		);
	}
	const entries: PushPlanEntry[] = [];
	let totalBytes = 0;
	for (const file of [...selected].sort()) {
		assertPushablePath(file, "That path cannot be pushed.");
		const read = await readFileSafely(input.root, file, {
			maxBytes: MAX_INLINE_PUSH_BYTES - totalBytes,
		});
		if (read === null) {
			if (!allowed.has(file))
				throw new Error(
					`Refusing to push: there is no file at ${file}.`,
				);
			entries.push({ path: file, action: "delete" });
		} else {
			totalBytes += read.bytes.length;
			entries.push({
				path: file,
				action: "put",
				size: read.bytes.length,
				sha256: createHash("sha256").update(read.bytes).digest("hex"),
			});
		}
	}
	return {
		entries,
		unchanged: input.files
			.filter((file) => !selected.has(file.path))
			.map((file) => file.path),
	};
}
