/**
 * Unit tests for the activity-capture decision helpers.
 *
 * `isCapturableMethod` is the single rule that determines how many rows this
 * middleware adds to a WORM, cryptographically sealed, retained ledger. Getting
 * it wrong is expensive in both directions — too broad floods the log with reads,
 * too narrow silently loses events — so it gets tests rather than just a comment.
 */

import { describe, expect, it } from "vitest";
import {
	deriveActivityAction,
	hasReadShapedName,
	isCapturableMethod,
	readDeclaredMethod,
	shouldCapture,
	shouldSkipPath,
} from "../audit-activity-middleware";

describe("isCapturableMethod", () => {
	it("captures write verbs", () => {
		for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
			expect(isCapturableMethod(method)).toBe(true);
		}
	});

	it("skips GET, case-insensitively", () => {
		expect(isCapturableMethod("GET")).toBe(false);
		expect(isCapturableMethod("get")).toBe(false);
	});

	it("captures an undeclared method", () => {
		// oRPC defaults to POST, so "no declared method" means "probably a
		// mutation". Over-capturing a few undeclared reads is the safer error:
		// a missing record cannot be recovered later, an excess one can be
		// filtered.
		expect(isCapturableMethod(undefined)).toBe(true);
	});
});

describe("readDeclaredMethod", () => {
	it("reads the route method off a procedure definition", () => {
		// Shape mirrors @orpc/server's own declarations: Procedure['~orpc'] is a
		// ProcedureDef extending ContractProcedureDef, which carries `route`.
		const procedure = { "~orpc": { route: { method: "GET" } } };
		expect(readDeclaredMethod(procedure)).toBe("GET");
	});

	it("returns undefined when no method is declared", () => {
		expect(readDeclaredMethod({ "~orpc": { route: {} } })).toBeUndefined();
	});

	it("returns undefined for a shape it does not recognise", () => {
		// Must not throw on an unexpected internal shape — a future oRPC version
		// changing this would degrade to "capture it", never to a crash on every
		// authenticated request.
		expect(readDeclaredMethod(undefined)).toBeUndefined();
		expect(readDeclaredMethod({})).toBeUndefined();
		expect(readDeclaredMethod({ "~orpc": {} })).toBeUndefined();
	});
});

describe("deriveActivityAction", () => {
	it("prefixes the dotted procedure path", () => {
		expect(deriveActivityAction(["projects", "create"])).toBe(
			"activity.projects.create",
		);
	});

	it("handles a nested router path", () => {
		expect(
			deriveActivityAction(["projects", "stories", "sync", "push"]),
		).toBe("activity.projects.stories.sync.push");
	});

	it("does not produce a bare prefix for an empty path", () => {
		// An empty path renders "(root)" rather than "activity." — a trailing-dot
		// key would sort and filter strangely in the viewer.
		expect(deriveActivityAction([])).toBe("activity.(root)");
	});
});

describe("shouldSkipPath", () => {
	it("still keeps every audit-surface read out of the ledger", () => {
		// Regression guard for a self-referential loop found in staging: these
		// declare POST because they take a request body, not because they mutate,
		// so opening the audit-log page wrote activity rows about opening the
		// audit-log page.
		//
		// Four of the five are no longer skipped BY PATH — `hasReadShapedName`
		// recognises them, which is why the path list shrank. This asserts the
		// OUTCOME rather than the mechanism, so it keeps guarding the loop
		// whichever rule happens to catch each one.
		for (const path of [
			"audit.stats",
			"audit.apiKeys.list",
			"audit.searchMembers",
			"audit.searchProjects",
			"audit.tracedRequest",
		]) {
			const segments = path.split(".");
			const suppressed =
				shouldSkipPath(path) ||
				!shouldCapture({
					method: "POST",
					readShapedName: hasReadShapedName(segments),
				});
			expect(suppressed, path).toBe(true);
		}
	});

	it("keeps tracedRequest in the path list, since no name rule catches it", () => {
		// The one that needs saying explicitly: `tracedRequest` reads like neither
		// a read nor a write, so dropping it from the list would silently
		// reintroduce the loop for that procedure only.
		expect(hasReadShapedName(["audit", "tracedRequest"])).toBe(false);
		expect(shouldSkipPath("audit.tracedRequest")).toBe(true);
	});

	it("skips the personal-calendar procedures unconditionally", () => {
		expect(
			shouldSkipPath("projects.meetingDigest.getPersonalTranscript"),
		).toBe(true);
	});

	it("does not skip an ordinary mutation", () => {
		expect(shouldSkipPath("projects.create")).toBe(false);
		expect(shouldSkipPath("audit.apiKeys.create")).toBe(false);
	});
});
