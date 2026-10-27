import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Parlume failed bot finalization", () => {
	it("preserves captured segments as an incomplete transcript and notes workflow", async () => {
		const [callback, finalizer] = await Promise.all([
			readFile(
				path.resolve(
					process.cwd(),
					"app/api/internal/parlume/callback/route.ts",
				),
				"utf8",
			),
			readFile(
				path.resolve(
					process.cwd(),
					"../../packages/api/modules/projects/lib/parlume-finalization.ts",
				),
				"utf8",
			),
		]);

		// Finalization waits only for a stream that opened and has not closed.
		expect(callback).toContain(
			"session.streamGeneration > 0 && session.streamClosedAt === null",
		);
		expect(callback).toContain("if (streamMayDrain)");
		expect(callback).toContain("preserveFailure: true");
		expect(callback).toContain(
			"expectedStreamGeneration: session.streamGeneration",
		);
		expect(finalizer).toContain(
			'const failedStatus: ParlumeMeetingSessionStatus = "FAILED"',
		);
		expect(finalizer).toContain(
			"? [{ status: failedStatus, finalizedAt: null }]",
		);
		expect(finalizer).toContain(
			'status: options.preserveFailure ? "FAILED" : "ENDED"',
		);
		expect(finalizer).toContain(
			"workflowId: `parlume-notes-$" + "{session.id}`",
		);
	});
});
