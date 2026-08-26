/**
 * Unit tests for FE correlation-id helpers.
 *
 * Verifies:
 *  - `generateClientCorrelationId()` prefixes with `req_` and uses
 *    `crypto.randomUUID()` when available.
 *  - `captureResponseCorrelationId()` honors both casings and ignores empty.
 *  - `currentCorrelationId()` returns the most recently captured value.
 *
 * Browser-bundle test: must never pull `node:async_hooks` into the SUT.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	captureResponseCorrelationId,
	currentCorrelationId,
	generateClientCorrelationId,
} from "../correlation-id";

describe("generateClientCorrelationId", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("returns a string starting with 'req_'", () => {
		const id = generateClientCorrelationId();
		expect(id).toMatch(/^req_/);
	});

	it("uses crypto.randomUUID when available", () => {
		const fixed = "11111111-2222-3333-4444-555555555555";
		vi.stubGlobal("crypto", {
			randomUUID: () => fixed,
		});
		const id = generateClientCorrelationId();
		expect(id).toBe(`req_${fixed}`);
	});

	it("falls back to base36 random when randomUUID is unavailable", () => {
		// Pretend we're on an HTTP-only ancient browser: no randomUUID.
		vi.stubGlobal("crypto", {
			/* no randomUUID */
		});
		const id = generateClientCorrelationId();
		// 16-char base36 random => pattern check
		expect(id).toMatch(/^req_[a-z0-9]+$/);
		expect(id.length).toBeGreaterThan(5); // Has actual content
	});

	it("generates unique IDs across calls (fallback path)", () => {
		vi.stubGlobal("crypto", {});
		const a = generateClientCorrelationId();
		const b = generateClientCorrelationId();
		expect(a).not.toBe(b);
	});
});

describe("captureResponseCorrelationId + currentCorrelationId", () => {
	beforeEach(() => {
		// Reset the module-level holder by capturing an empty headers bag.
		// We can't fully clear it, but we can stamp known sentinel values.
	});

	it("captures lowercase x-correlation-id header", () => {
		const h = new Headers({ "x-correlation-id": "req_abc_lower" });
		captureResponseCorrelationId(h);
		expect(currentCorrelationId()).toBe("req_abc_lower");
	});

	it("captures uppercase X-Correlation-ID header", () => {
		const h = new Headers({ "X-Correlation-ID": "req_xyz_upper" });
		captureResponseCorrelationId(h);
		// Headers normalises to lowercase, but the helper checks both.
		expect(currentCorrelationId()).toBe("req_xyz_upper");
	});

	it("ignores null headers (no-op)", () => {
		// Set a baseline then call with null.
		captureResponseCorrelationId(
			new Headers({ "x-correlation-id": "baseline" }),
		);
		expect(currentCorrelationId()).toBe("baseline");
		captureResponseCorrelationId(null);
		expect(currentCorrelationId()).toBe("baseline");
	});

	it("ignores whitespace-only header values", () => {
		captureResponseCorrelationId(
			new Headers({ "x-correlation-id": "stamp-a" }),
		);
		captureResponseCorrelationId(
			new Headers({ "x-correlation-id": "   " }),
		);
		expect(currentCorrelationId()).toBe("stamp-a");
	});

	it("returns the latest captured value", () => {
		captureResponseCorrelationId(
			new Headers({ "x-correlation-id": "id-1" }),
		);
		captureResponseCorrelationId(
			new Headers({ "x-correlation-id": "id-2" }),
		);
		captureResponseCorrelationId(
			new Headers({ "x-correlation-id": "id-3" }),
		);
		expect(currentCorrelationId()).toBe("id-3");
	});
});
