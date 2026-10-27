import assert from "node:assert/strict";
import test from "node:test";
import { disposableTarget } from "../prisma-disposable.mjs";

const direct = "postgresql://example:example@localhost:5432/example_direct";
const shadow = "postgresql://example:example@127.0.0.1:5432/example_shadow";

test("diff clears only its separate disposable shadow database", () => {
	assert.equal(
		disposableTarget("diff", {
			DIRECT_URL: direct,
			SHADOW_DATABASE_URL: shadow,
		}),
		shadow,
	);
});
test("reset clears its explicit disposable direct database", () => {
	assert.equal(disposableTarget("reset", { DIRECT_URL: direct }), direct);
});
test("rejects a missing shadow URL before opening a connection", () => {
	assert.throws(
		() => disposableTarget("diff", { DIRECT_URL: direct }),
		/SHADOW_DATABASE_URL/,
	);
});
test("rejects a shared direct/shadow target", () => {
	assert.throws(
		() =>
			disposableTarget("diff", {
				DIRECT_URL: direct,
				SHADOW_DATABASE_URL: direct,
			}),
		/different/,
	);
});
for (const url of [
	"postgresql://example:example@example.com/example_shadow",
	"postgresql://example:example@localhost/shared_database",
	"https://localhost/example_shadow",
	"postgresql://example:example@localhost/example_shadow?host=example.com",
]) {
	test(`rejects an unsafe disposable target ${url}`, () => {
		assert.throws(
			() => disposableTarget("reset", { DIRECT_URL: url }),
			/loopback|example_|PostgreSQL|parameters/,
		);
	});
}
test("does not accept other Prisma commands", () => {
	assert.throws(
		() => disposableTarget("deploy", { DIRECT_URL: direct }),
		/reset or diff/,
	);
});
