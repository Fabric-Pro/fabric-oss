import { expect, it } from "vitest";
import { projectContextSourceName } from "../source-name";

it.each([
	[
		{
			sourcePath: "path",
			filename: "file",
			sourceTitle: "title",
			sourceUrl: "url",
		},
		"path",
	],
	[{ filename: "file", sourceTitle: "title", sourceUrl: "url" }, "file"],
	[{ sourceTitle: "title", sourceUrl: "url" }, "title"],
	[{ sourceUrl: "url" }, "url"],
	[{}, "Context 2"],
] as const)("names %j as %s", (source, expected) => {
	expect(projectContextSourceName(source, 1)).toBe(expected);
});
