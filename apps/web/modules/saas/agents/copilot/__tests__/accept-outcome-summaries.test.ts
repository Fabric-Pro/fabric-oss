/**
 * Why an AI accept on a client-document Proposal was not applied, when its
 * save was refused for its revision token (Fizzy #2946).
 *
 * The server answers that one code for a token past its expiry and for a
 * saved section that is not the reviewed one, so the copy names both
 * causes and claims neither: in the chat's record and in the editor's
 * toast, in English and German.
 */

import de from "@repo/i18n/translations/de.json";
import en from "@repo/i18n/translations/en.json";
import { describe, expect, it } from "vitest";
import {
	ACCEPT_OUTCOME_SUMMARIES,
	acceptNotAppliedReason,
} from "../accept-outcome-summaries";

describe("an accept refused for its revision token", () => {
	it("records both causes in the chat", () => {
		expect(
			ACCEPT_OUTCOME_SUMMARIES.notApplied(
				acceptNotAppliedReason("REVISION_TOKEN_INVALID"),
			),
		).toBe(
			"Not applied: the revision had expired, or the accepted text differed from what was reviewed. Request it again.",
		);
	});

	it("names both causes in the editor's toast", () => {
		const reasons = {
			en: en.projects.proposalArtifact.revision.reasons
				.REVISION_TOKEN_INVALID,
			de: de.projects.proposalArtifact.revision.reasons
				.REVISION_TOKEN_INVALID,
		};

		expect(reasons.en).toBe(
			"the revision has expired, or the accepted text differs from what was reviewed. Request it again.",
		);
		expect(reasons.de).toBe(
			"die Überarbeitung ist abgelaufen oder der angenommene Text weicht von der geprüften Fassung ab. Fordern Sie sie erneut an.",
		);
	});
});
