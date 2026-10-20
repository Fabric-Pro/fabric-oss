import { describe, expect, it } from "vitest";
import { humanizePmSyncError } from "../humanize-pm-sync-error";
import {
	describeSyncErrorForUser,
	isDatabaseError,
	prismaErrorCode,
	redactDatabaseErrorText,
} from "../pm-sync-user-error";

const message =
	"Invalid `prisma.userStory.update()` invocation in\n/app/packages/example/file.ts:123:45\nSELECT secret FROM example;";

describe("PM sync user errors", () => {
	it("recognizes database shapes and preserves complete PM-tool messages and odd values", () => {
		for (const [extra, expected] of [
			[{ code: "P2024" }, "database error P2024"],
			[{ errorCode: "P1001" }, "database error P1001"],
			[{ name: "PrismaClientInitializationError" }, "database error"],
			[{ name: "PrismaClientUnknownRequestError" }, "database error"],
			[{ name: "DriverAdapterError" }, "database error"],
		] as const) {
			const error = Object.assign(new Error(message), extra);
			expect(isDatabaseError(error)).toBe(true);
			expect(describeSyncErrorForUser(error)).toBe(expected);
		}
		const pmMessage =
			"404: item not found\nCheck the PM board permissions.";
		expect(describeSyncErrorForUser(new Error(pmMessage))).toBe(pmMessage);
		for (const value of [
			null,
			undefined,
			42,
			"tool failed",
			Symbol("example"),
		]) {
			expect(isDatabaseError(value)).toBe(false);
			expect(describeSyncErrorForUser(value)).toBe(String(value));
		}
		expect(
			describeSyncErrorForUser({
				toString() {
					throw new Error("bad coercion");
				},
			}),
		).toBe("unknown error");
		expect(prismaErrorCode({ code: "SQLSTATE", errorCode: "P1001" })).toBe(
			"P1001",
		);
		expect(prismaErrorCode({ code: "P2024 extra" })).toBeNull();
	});

	it("redacts serialized database messages before humanization without changing PM classifiers", () => {
		expect(redactDatabaseErrorText(message)).toBe("database error");

		for (const errorClass of [
			"PrismaClientKnownRequestError",
			"PrismaClientInitializationError",
			"DriverAdapterError",
		]) {
			expect(
				redactDatabaseErrorText(
					"query contains a server path",
					errorClass,
				),
			).toBe("database error");
			expect(
				redactDatabaseErrorText(
					"query arguments include P1234",
					errorClass,
				),
			).toBe("database error");
		}
		for (const pmMessage of [
			"404: item not found",
			"Invalid `create_card` invocation: board not found",
			"Invalid `create_card()` invocation: board not found",
			"Invalid create_card() invocation",
			"PM tool rejected P2002 as a card identifier",
			"cloud id isn't granted",
			"Error retrieving work item: Client does not support form elicitation.",
		]) {
			expect(redactDatabaseErrorText(pmMessage, "McpError")).toBe(
				pmMessage,
			);
			expect(
				humanizePmSyncError(redactDatabaseErrorText(pmMessage)),
			).toBe(humanizePmSyncError(pmMessage));
		}
	});
});

it("redacts Prisma panic invocations without reading P-codes from query arguments", () => {
	const panic =
		"An error occurred in the `prisma.userStory.update()` invocation\n/app/packages/example/file.ts:123:45\nwhere: { title: 'P1234' }";
	expect(redactDatabaseErrorText(panic)).toBe("database error");
	expect(
		redactDatabaseErrorText(
			"Invalid `prisma.userStory.update()` invocation in\n/app/packages/example/file.ts:123:45\nwhere: { title: 'P1234' }",
		),
	).toBe("database error");
	expect(
		redactDatabaseErrorText(
			"query arguments include P1234",
			"PrismaClientKnownRequestError",
		),
	).toBe("database error");
	for (const message of [
		"Failure in the `create_card()` invocation",
		"PM card P1234 not found",
	]) {
		expect(redactDatabaseErrorText(message)).toBe(message);
	}
});

it("recognizes bounded native and MCP cause chains and preserves the Prisma code", () => {
	const prisma = Object.assign(new Error("required but not found"), {
		code: "P2025",
	});
	const error = Object.assign(new Error("MCP failed"), {
		originalCause: new Error("transport failed", { cause: prisma }),
	});
	expect(isDatabaseError(error)).toBe(true);
	expect(prismaErrorCode(error)).toBe("P2025");
	expect(describeSyncErrorForUser(error)).toBe("database error P2025");
});

it("bounds cyclic, deep, and hostile cause chains without treating text as provenance", () => {
	const cyclic = {
		cause: null as unknown,
		originalCause: { name: "DriverAdapterError" },
	};
	cyclic.cause = cyclic;
	expect(isDatabaseError(cyclic)).toBe(true);
	expect(
		isDatabaseError({
			get cause() {
				throw new Error("bad getter");
			},
		}),
	).toBe(false);
	expect(isDatabaseError(new Error("P2025 required but not found"))).toBe(
		false,
	);
	let deep: unknown = { code: "P2025" };
	for (let i = 0; i < 100; i++) {
		deep = { cause: deep };
	}
	expect(isDatabaseError(deep)).toBe(false);
	expect(prismaErrorCode(deep)).toBeNull();
});
