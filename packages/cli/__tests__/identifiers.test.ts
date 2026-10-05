/**
 * A project id and an organization slug are plain identifiers wherever they
 * cross into a command line, a request or a line of output (Fizzy #2878): the
 * option parser, the resolver's answer and the hook command's builder all ask
 * the same question.
 */
import { describe, expect, it } from "vitest";
import {
	buildHookCommand,
	buildLessonPromptCommand,
} from "../src/lib/instructions/hook.js";
import { isIdentifier } from "../src/lib/instructions/identifiers.js";

describe("isIdentifier", () => {
	it.each([
		"a",
		"project-1",
		"Project_1.v2",
		"cm0abc123xyz",
		"1234",
		"a".repeat(64),
	])("accepts %s", (value) => {
		expect(isIdentifier(value)).toBe(true);
	});

	it.each([
		["nothing", ""],
		["a leading dash", "-x"],
		["a leading dot", ".x"],
		["a leading underscore", "_x"],
		["a space", "a b"],
		["a semicolon", "x;y"],
		["a dollar sign", "$(id)"],
		["a backtick", "`id`"],
		["a hash", "x#"],
		["a slash", "a/b"],
		["a quote", "a'b"],
		["a trailing newline", "project-1\n"],
		["a control character", "a\u0007"],
		["a C1 control", "a\u009b"],
		["a non-ASCII letter", "projeté"],
		["65 characters", "a".repeat(65)],
	])("refuses %s", (_label, value) => {
		expect(isIdentifier(value)).toBe(false);
	});
});

describe("the hook commands", () => {
	const HOSTILE = "x; touch pwned #";

	it("carry a plain project id and organization slug", () => {
		const check = buildHookCommand("project-1", false, "example-org");
		const lessons = buildLessonPromptCommand("project-1", "example-org");

		expect(check).toBe(
			"fabric instructions check --project project-1 --org example-org --hook",
		);
		expect(lessons).toBe(
			"fabric instructions lesson-prompt --project project-1 --org example-org --hook",
		);
	});

	it("are never built from a project id that is not one", () => {
		expect(() => buildHookCommand(HOSTILE, false)).toThrow(
			"plain identifiers",
		);
		expect(() => buildHookCommand(HOSTILE, true, "example-org")).toThrow(
			"plain identifiers",
		);
		expect(() => buildLessonPromptCommand(HOSTILE)).toThrow(
			"plain identifiers",
		);
	});

	it.each([
		HOSTILE,
		"$(id)",
		"my remote",
		"origin\nfabric",
		"-oProxyCommand=x",
		"/srv/git",
	])("are never bound to the remote named %j", (remote) => {
		expect(() =>
			buildHookCommand("project-1", false, undefined, { remote }),
		).toThrow("plain git remote name");
		expect(() =>
			buildHookCommand("project-1", true, "example-org", {
				baseUrl: "https://example.com",
				remote,
			}),
		).toThrow("plain git remote name");
	});

	it.each([
		"origin",
		"upstream",
		"my-fork",
		"team/fork",
		".hidden",
		"_x",
		"a.b",
	])("are bound to the remote named %s", (remote) => {
		expect(
			buildHookCommand("project-1", false, undefined, { remote }),
		).toBe(
			`fabric instructions check --project project-1 --remote ${remote} --hook`,
		);
	});

	it("leave an empty remote out, as before", () => {
		expect(
			buildHookCommand("project-1", false, undefined, { remote: "" }),
		).toBe("fabric instructions check --project project-1 --hook");
	});

	it("are never built from an organization slug that is not one", () => {
		expect(() => buildHookCommand("project-1", false, HOSTILE)).toThrow(
			"plain identifiers",
		);
		expect(() => buildLessonPromptCommand("project-1", "$(id)")).toThrow(
			"plain identifiers",
		);
	});
});
