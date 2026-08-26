import { createHash } from "node:crypto";

/** Stable content hash used for incremental change detection (R9). */
export function hashContent(content: string): string {
	return createHash("sha1").update(content).digest("hex");
}
