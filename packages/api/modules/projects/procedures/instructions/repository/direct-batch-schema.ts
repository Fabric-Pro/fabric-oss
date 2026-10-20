import { validateRelativePath } from "@repo/instructions";
import { z } from "zod";
import { commitShaSchema } from "./commit-sha";

export const repositoryFilesReadSchema = z
	.object({
		generation: z.number().int().nonnegative(),
		commitSha: commitShaSchema,
		paths: z
			.array(z.string().min(1).max(512))
			.min(1)
			.max(200)
			.refine(
				(paths) =>
					new Set(paths).size === paths.length &&
					paths.every((path) => {
						const checked = validateRelativePath(path);
						return checked.ok && checked.path === path;
					}),
				"Expected unique relative repository paths",
			),
		startIndex: z.number().int().nonnegative().default(0),
	})
	.refine(
		(input) => input.startIndex < input.paths.length,
		"Invalid startIndex",
	);
