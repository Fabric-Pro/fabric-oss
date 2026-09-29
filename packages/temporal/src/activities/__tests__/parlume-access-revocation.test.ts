import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Parlume inviter access revocation", () => {
	it("stops the active meeting through the durable bridge before it can execute another turn", async () => {
		const source = await readFile(
			new URL("../parlume.ts", import.meta.url),
			"utf8",
		);
		const accessCheck = source.indexOf("if (!hasAccess)");
		const nextBranch = source.indexOf("const instance", accessCheck);
		const revoked = source.slice(accessCheck, nextBranch);

		expect(accessCheck).toBeGreaterThan(-1);
		expect(revoked).toContain('status: "LEAVING"');
		expect(revoked).toContain("requestParlumeMeetingStop");
		expect(revoked).toContain(
			"The inviter no longer has access to this project.",
		);
	});
});
