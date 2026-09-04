/**
 * The production fail-closed guard shared by the client `Connection` and the
 * worker `NativeConnection` (Fizzy #2399). It is the one piece of the
 * connection policy that is pure logic, so it gets a direct test: a plaintext
 * Temporal channel is refused under NODE_ENV=production unless the emergency
 * override is set, and is allowed everywhere else.
 */

import { afterEach, describe, expect, it } from "vitest";
import { assertInsecureConnectionAllowed } from "../src/client";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_OVERRIDE = process.env.TEMPORAL_ALLOW_INSECURE;

function restore(name: string, value: string | undefined) {
	if (value === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = value;
	}
}

afterEach(() => {
	restore("NODE_ENV", ORIGINAL_NODE_ENV);
	restore("TEMPORAL_ALLOW_INSECURE", ORIGINAL_OVERRIDE);
});

describe("assertInsecureConnectionAllowed", () => {
	it("refuses a plaintext connection in production", () => {
		process.env.NODE_ENV = "production";
		delete process.env.TEMPORAL_ALLOW_INSECURE;
		expect(() => assertInsecureConnectionAllowed("[Worker]")).toThrow(
			/\[Worker\] Refusing to start in production/,
		);
	});

	it("honours the emergency override in production", () => {
		process.env.NODE_ENV = "production";
		process.env.TEMPORAL_ALLOW_INSECURE = "true";
		expect(() =>
			assertInsecureConnectionAllowed("[Temporal]"),
		).not.toThrow();
	});

	it("does not treat any other override value as consent", () => {
		process.env.NODE_ENV = "production";
		process.env.TEMPORAL_ALLOW_INSECURE = "1";
		expect(() => assertInsecureConnectionAllowed("[Temporal]")).toThrow();
	});

	it("allows a plaintext connection outside production", () => {
		process.env.NODE_ENV = "development";
		delete process.env.TEMPORAL_ALLOW_INSECURE;
		expect(() =>
			assertInsecureConnectionAllowed("[Temporal]"),
		).not.toThrow();
	});
});
