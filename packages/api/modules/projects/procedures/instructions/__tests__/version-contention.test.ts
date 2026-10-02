import { ORPCError } from "@orpc/client";
import { describe, expect, it } from "vitest";
import { versionContentionAsConflict } from "../version-contention";

describe("versionContentionAsConflict", () => {
	it("answers the typed contention error as a CONFLICT with a stable reason and a plain message", () => {
		const contention = Object.assign(new Error("lost the race"), {
			name: "InstructionVersionContentionError",
		});

		let thrown: unknown;
		try {
			versionContentionAsConflict(contention);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(ORPCError);
		expect(thrown).toMatchObject({
			code: "CONFLICT",
			message:
				"Several versions were started on this project at the same moment. Try again.",
			data: { reason: "VERSION_CONTENTION" },
		});
	});

	it("lets any other error through unchanged, including a raw unique violation", () => {
		const raw = Object.assign(new Error("Unique constraint failed"), {
			code: "P2002",
		});

		expect(() => versionContentionAsConflict(raw)).toThrow(raw);
	});

	it("is usable as a promise catch handler", async () => {
		const contention = Object.assign(new Error("x"), {
			name: "InstructionVersionContentionError",
		});

		await expect(
			Promise.reject(contention).catch(versionContentionAsConflict),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
});
