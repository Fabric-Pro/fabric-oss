import { describe, expect, it } from "vitest";
import de from "../../../../../packages/i18n/translations/de.json";
import en from "../../../../../packages/i18n/translations/en.json";

describe("Genie result copy", () => {
	const keys = [
		"toolFailuresTitle",
		"toolFailuresDescription",
		"toolFailed",
		"toolAwaitingConfirmation",
		"toolNeedsInspection",
		"toolCompleted",
		"toolRunning",
		"toolCancelled",
		"toolSkipped",
		"toolRecorded",
	] as const;
	it.each(keys)(
		"provides meaningful English and German copy for %s",
		(key) => {
			for (const messages of [en, de]) {
				expect(messages.genieExperience[key]).toBeTruthy();
				expect(messages.genieExperience[key]).not.toBe(key);
			}
		},
	);
});
