import en from "@repo/i18n/translations/en.json";
import { describe, expect, it, vi } from "vitest";

const { createTranslator } =
	await vi.importActual<typeof import("next-intl")>("next-intl");

const t = createTranslator({
	locale: "en",
	messages: en,
	namespace: "projects.codingInstructions.proposalReview.branch",
});

describe("branch confirmation copy counts its changes in the singular and the plural", () => {
	it.each([
		[
			"closeConfirm",
			1,
			"Fabric closes the pull request and withdraws its 1 change.",
		],
		[
			"closeConfirm",
			2,
			"Fabric closes the pull request and withdraws its 2 changes.",
		],
		[
			"startOverConfirm",
			1,
			"adds your 1 change to a new branch and pull request.",
		],
		[
			"startOverConfirm",
			3,
			"adds your 3 changes to a new branch and pull request.",
		],
	] as const)("%s with %i", (key, count, expected) => {
		expect(t(key, { count })).toContain(expected);
	});
});
