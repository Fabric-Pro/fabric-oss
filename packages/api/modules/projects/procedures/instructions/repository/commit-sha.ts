import { z } from "zod";

/** A full Git object id: SHA-1, or SHA-256 for repositories that use it. */
export const commitShaSchema = z
	.string()
	.regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
