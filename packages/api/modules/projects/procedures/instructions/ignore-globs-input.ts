import { PROJECT_IGNORE_GLOB_LIMITS } from "@repo/instructions";
import { z } from "zod";

/**
 * A project's own ignore list as a procedure accepts it: at most
 * `maxGlobs` non-empty rules of at most `maxGlobLength` characters. Shared
 * by `updateSettings` and `repositorySync.configure` (which writes the
 * configure dialog's folder exclusions with the configuration, Fizzy #2726),
 * so the two writers of the list accept exactly the same lists.
 */
export const projectIgnoreGlobsSchema = z
	.array(z.string().min(1).max(PROJECT_IGNORE_GLOB_LIMITS.maxGlobLength))
	.max(PROJECT_IGNORE_GLOB_LIMITS.maxGlobs);
