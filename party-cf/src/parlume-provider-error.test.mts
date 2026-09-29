import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("a provider stream error persists the durable retry marker before requesting leave", async () => {
	const source = await readFile(
		new URL("./parlume.ts", import.meta.url),
		"utf8",
	);
	const errorBranchStart = source.indexOf('if (event.event === "error")');
	const errorBranchEnd = source.indexOf(
		"if (!event.data.isFinal)",
		errorBranchStart,
	);
	const errorBranch = source.slice(errorBranchStart, errorBranchEnd);

	assert.ok(errorBranchStart > -1);
	assert.ok(errorBranchEnd > errorBranchStart);
	assert.match(errorBranch, /storage\.put<StreamError>\(STREAM_ERROR_KEY/);
	assert.match(errorBranch, /await this\.reportStreamFailure\(\)/);
});
