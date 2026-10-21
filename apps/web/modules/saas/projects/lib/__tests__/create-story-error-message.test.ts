import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getCreateStoryErrorMessage } from "../create-story-error-message";

const here = dirname(fileURLToPath(import.meta.url));

describe("getCreateStoryErrorMessage", () => {
	it("shows the server refusal message", () => {
		expect(
			getCreateStoryErrorMessage(
				new Error("Reconnect your ChatGPT connection."),
				(key) => key,
			),
		).toBe("Reconnect your ChatGPT connection.");
	});
	it.each([null, "failure", {}])(
		"uses the translated create failure for %j",
		(error) => {
			expect(
				getCreateStoryErrorMessage(error, (key) => `translated:${key}`),
			).toBe("translated:creationFailed");
		},
	);
	it.each(["StoriesRoadmap", "CreateStoryDialog"])(
		"wires the %s catch to the shared selector",
		(component) => {
			const source = readFileSync(
				resolve(here, `../../components/stories/${component}.tsx`),
				"utf8",
			);
			expect(source).toMatch(
				/catch \(error\)\s*\{\s*toast\.error\(\s*getCreateStoryErrorMessage\(error, tCreate\)/,
			);
			expect(source).not.toContain('tCreate("titleGenerationFailed")');
		},
	);
});

it.each(["en", "de"])("maintains the create failure key in %s", (locale) => {
	const translations = JSON.parse(
		readFileSync(
			resolve(
				here,
				`../../../../../../../packages/i18n/translations/${locale}.json`,
			),
			"utf8",
		),
	);
	expect(translations.projects.stories.create.creationFailed).toEqual(
		expect.any(String),
	);
	expect(translations.projects.stories.create).not.toHaveProperty(
		"titleGenerationFailed",
	);
});
