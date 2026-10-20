import { describe, expect, it, vi } from "vitest";
import { describeLinkWriteCause } from "../pm-create-orphan";

vi.mock("@repo/database", () => ({ db: {} }));
vi.mock("@repo/logs", () => ({ logger: {} }));
vi.mock("../record-pm-sync-state", () => ({}));

const prismaMessage =
	"Invalid `prisma.userStory.update()` invocation in\n/app/packages/database/x.ts:12:3\nquery text";

describe("describeLinkWriteCause", () => {
	it.each(["item", "story", "test case"])(
		"describes a duplicate link with the %s noun",
		(noun) => {
			const error = Object.assign(new Error(prismaMessage), {
				name: "PrismaClientKnownRequestError",
				code: "P2002",
			});
			expect(describeLinkWriteCause(error, noun)).toBe(
				`another ${noun} in this project is already linked to that item`,
			);
		},
	);

	it("describes another Prisma P-code without query details", () => {
		const error = Object.assign(new Error(prismaMessage), {
			name: "PrismaClientKnownRequestError",
			code: "P2025",
		});
		expect(describeLinkWriteCause(error, "story")).toBe(
			"database error P2025",
		);
	});

	it.each([
		"PrismaClientUnknownRequestError",
		"PrismaClientInitializationError",
		"PrismaClientRustPanicError",
		"PrismaClientValidationError",
	])("hides details from %s without a P-code", (name) => {
		const error = Object.assign(new Error(prismaMessage), { name });
		expect(describeLinkWriteCause(error, "story")).toBe("database error");
	});

	it("hides an unwrapped driver adapter error's server message", () => {
		const error = Object.assign(
			new Error(
				'constraint "example_constraint" on table "example_table" failed',
			),
			{ name: "DriverAdapterError" },
		);
		expect(describeLinkWriteCause(error, "item")).toBe("database error");
	});

	it("keeps a driver adapter error's P-code without its message", () => {
		const error = Object.assign(new Error("example_table failed"), {
			name: "DriverAdapterError",
			code: "P2025",
		});
		expect(describeLinkWriteCause(error, "item")).toBe(
			"database error P2025",
		);
	});

	it("reads an initialization error's errorCode", () => {
		const error = Object.assign(new Error(prismaMessage), {
			name: "PrismaClientInitializationError",
			errorCode: "P1001",
		});
		expect(describeLinkWriteCause(error, "story")).toBe(
			"database error P1001",
		);
	});

	it("keeps a plain error's short cause", () => {
		expect(
			describeLinkWriteCause(new Error("pool exhausted"), "story"),
		).toBe("pool exhausted");
	});

	it("keeps only the trimmed first line of a plain error", () => {
		expect(
			describeLinkWriteCause(
				new Error("  pool exhausted  \nmore details"),
				"story",
			),
		).toBe("pool exhausted");
	});

	it("trims leading newlines before selecting the first line", () => {
		expect(
			describeLinkWriteCause(
				new Error("\n  pool exhausted\nmore details"),
				"story",
			),
		).toBe("pool exhausted");
	});

	it.each(["", " \n\t "])(
		"uses an unknown cause for an empty message %j",
		(message) => {
			expect(describeLinkWriteCause(new Error(message), "story")).toBe(
				"unknown error",
			);
		},
	);

	it("limits a plain error's cause to 200 characters", () => {
		expect(
			describeLinkWriteCause(new Error("x".repeat(201)), "story"),
		).toBe("x".repeat(200));
	});
});
