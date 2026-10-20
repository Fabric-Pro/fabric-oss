/**
 * What a person is told when a document generation is refused or does not
 * start a new run (Fizzy #2946).
 *
 * The server refuses a Proposal while nothing is bound to Client proposal
 * (Main), and refuses a new organization or project default at an action the
 * Proposal artifact supersedes, each with a code. Every surface that starts,
 * retries or binds shares one mapper from those codes to localized copy with
 * a link to the catalog entry that fixes it, and one mapper from a
 * regenerate's outcome to its toast. Anything the mappers do not recognise
 * stays with the caller's own fallback.
 */

import { PROPOSAL_PROMPT_NOT_BOUND } from "@repo/temporal/proposal-artifact-types";
import { PROPOSAL_ACTION_SUPERSEDED } from "@repo/utils/prompt-action-catalog";
import {
	describeBatchSkip,
	describeGenerationRefusal,
	type GenerationRefusalFeedback,
	type GenerationRefusalKind,
	proposalMainCatalogHref,
	type RegenerateToastKey,
	resolveRegenerateToastKey,
} from "@saas/projects/components/proposal-artifact/generation-feedback";
import { createTranslator, type useTranslations } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import de from "../../../../../../../packages/i18n/translations/de.json";
import en from "../../../../../../../packages/i18n/translations/en.json";

type Translate = ReturnType<typeof useTranslations>;

// The shared setup mocks `next-intl`; the real translator renders the shipped
// copy, so a missing key fails here.
vi.mock("next-intl", async (importOriginal) => await importOriginal());

const NAMESPACE = "projects.proposalArtifact.generationFeedback";
const BASE_PATH = "/app/example-org";
const CATALOG_HREF =
	"/app/example-org/prompts/catalog?action=proposal_client_main%3APROPOSAL%3AANY";

function translatorFor(locale: "en" | "de"): Translate {
	return createTranslator({
		locale,
		messages: locale === "en" ? en : de,
		namespace: NAMESPACE,
	}) as unknown as Translate;
}

const enContext = { t: translatorFor("en"), basePath: BASE_PATH };
const deContext = { t: translatorFor("de"), basePath: BASE_PATH };

/** An oRPC client error as the browser receives it. */
function orpcError(code: string, data?: unknown) {
	return Object.assign(new Error("server text"), { code, data });
}

describe("proposalMainCatalogHref", () => {
	it("links the Prompt Library catalog focused on Client proposal (Main)", () => {
		expect(proposalMainCatalogHref(BASE_PATH)).toBe(CATALOG_HREF);
	});
});

describe("describeGenerationRefusal", () => {
	it("words an unbound Client proposal (Main) in the reader's locale, with the catalog link", () => {
		const feedback = describeGenerationRefusal(
			orpcError("PRECONDITION_FAILED", {
				code: PROPOSAL_PROMPT_NOT_BOUND,
			}),
			enContext,
		);

		expect(feedback).toEqual<GenerationRefusalFeedback>({
			kind: "promptNotBound",
			message:
				"A Proposal can't be generated until a prompt is bound to Client proposal (Main). An organization admin binds one in the Prompt Library, or a project admin in the project's prompt defaults.",
			catalog: {
				href: CATALOG_HREF,
				label: "Open Client proposal (Main) in the Prompt Library",
			},
		});
	});

	it("words a refused default at a superseded action, naming Client proposal (Main)", () => {
		const feedback = describeGenerationRefusal(
			orpcError("BAD_REQUEST", { code: PROPOSAL_ACTION_SUPERSEDED }),
			enContext,
		);

		expect(feedback?.kind).toBe("actionSuperseded");
		expect(feedback?.message).toBe(
			"This action is not used while the Proposal artifact is on: Client proposal (Main) writes Proposals. Bind the prompt there instead.",
		);
		expect(feedback?.catalog.href).toBe(CATALOG_HREF);
	});

	it("never shows the server's English to a German reader", () => {
		const notBound = describeGenerationRefusal(
			orpcError("PRECONDITION_FAILED", {
				code: PROPOSAL_PROMPT_NOT_BOUND,
			}),
			deContext,
		);
		const superseded = describeGenerationRefusal(
			orpcError("BAD_REQUEST", { code: PROPOSAL_ACTION_SUPERSEDED }),
			deContext,
		);

		expect(notBound?.message).toContain("Prompt-Bibliothek");
		expect(notBound?.message).toContain("„Client proposal (Main)“");
		expect(superseded?.message).toContain("Proposal-Artefakt");
		expect(superseded?.message).toContain("„Client proposal (Main)“");
		expect(notBound?.catalog.label).toContain("Prompt-Bibliothek öffnen");
		for (const feedback of [notBound, superseded]) {
			expect(feedback?.message).not.toBe("server text");
			expect(feedback?.catalog.href).toBe(CATALOG_HREF);
		}
	});

	it("reads the code from either refusal status", () => {
		expect(
			describeGenerationRefusal(
				orpcError("BAD_REQUEST", { code: PROPOSAL_PROMPT_NOT_BOUND }),
				enContext,
			)?.kind,
		).toBe("promptNotBound");
		expect(
			describeGenerationRefusal(
				orpcError("PRECONDITION_FAILED", {
					code: PROPOSAL_ACTION_SUPERSEDED,
				}),
				enContext,
			)?.kind,
		).toBe("actionSuperseded");
	});

	it("leaves every other failure to the caller's own fallback", () => {
		for (const error of [
			// A refusal status with some other code.
			orpcError("PRECONDITION_FAILED", { code: "SOMETHING_ELSE" }),
			// A capability gate refusal carries a gate, not a code.
			orpcError("PRECONDITION_FAILED", {
				gate: { capabilityKey: "documents.generate-prd" },
			}),
			// A batch whose every document was skipped carries `skipped`.
			orpcError("PRECONDITION_FAILED", {
				gate: null,
				skipped: [
					{
						type: "PROPOSAL",
						reasonKey: "documents.proposal-prompt-not-bound",
						message: "server text",
					},
				],
			}),
			// The right data code under a status neither refusal uses.
			orpcError("CONFLICT", { code: PROPOSAL_PROMPT_NOT_BOUND }),
			orpcError("INTERNAL_SERVER_ERROR", {
				code: PROPOSAL_ACTION_SUPERSEDED,
			}),
			orpcError("PRECONDITION_FAILED", "PROPOSAL_PROMPT_NOT_BOUND"),
			orpcError("PRECONDITION_FAILED"),
			new Error("network down"),
			{ data: { code: PROPOSAL_PROMPT_NOT_BOUND } },
			"PROPOSAL_PROMPT_NOT_BOUND",
			null,
			undefined,
		]) {
			expect(describeGenerationRefusal(error, enContext)).toBeNull();
		}
	});
});

describe("describeBatchSkip", () => {
	it("words a Proposal skipped for an unbound Client proposal (Main)", () => {
		const feedback = describeBatchSkip(
			"documents.proposal-prompt-not-bound",
			enContext,
		);

		expect(feedback?.kind).toBe("promptNotBound");
		expect(feedback?.message).toContain("Client proposal (Main)");
		expect(feedback?.catalog.href).toBe(CATALOG_HREF);
	});

	it("leaves every other skip reason to the caller", () => {
		for (const reasonKey of [
			"codebase.not-connected",
			"documents.something-newer",
			null,
			undefined,
		]) {
			expect(describeBatchSkip(reasonKey, enContext)).toBeNull();
		}
	});
});

describe("resolveRegenerateToastKey", () => {
	it("says a run began when one did", () => {
		expect(
			resolveRegenerateToastKey({
				outcome: "started",
				documentStatus: "QUEUED",
			}),
		).toBe("started");
	});

	it("words a joined run from the document's own state", () => {
		expect(
			resolveRegenerateToastKey({
				outcome: "alreadyInProgress",
				documentStatus: "QUEUED",
			}),
		).toBe("alreadyQueued");
		expect(
			resolveRegenerateToastKey({
				outcome: "alreadyInProgress",
				documentStatus: "GENERATING",
			}),
		).toBe("alreadyRunning");
	});

	it("says a live run's state could not be confirmed, whatever the row reads", () => {
		for (const documentStatus of ["QUEUED", "GENERATING", null]) {
			expect(
				resolveRegenerateToastKey({
					outcome: "liveRunUnknown",
					documentStatus,
				}),
			).toBe("liveRunUnknown");
		}
	});

	it("reads this request's own ambiguous start as started: the row is queued for it", () => {
		for (const documentStatus of ["QUEUED", "GENERATING", null]) {
			expect(
				resolveRegenerateToastKey({
					outcome: "statusUnknown",
					documentStatus,
				}),
			).toBe("started");
		}
	});

	it("resolves an unrecognised or absent outcome to the start copy", () => {
		for (const outcome of ["somethingNewer", null, undefined]) {
			expect(
				resolveRegenerateToastKey({
					outcome,
					documentStatus: "GENERATING",
				}),
			).toBe("started");
		}
	});
});

describe("shipped copy", () => {
	type Messages = {
		projects: {
			documents: { regenerateToast: Record<string, string> };
			proposalArtifact: {
				generationFeedback: Record<string, string>;
			};
		};
	};

	// Records over the exported unions, so a new kind or toast key cannot be
	// added without being listed here.
	const refusalKinds: Record<GenerationRefusalKind, true> = {
		promptNotBound: true,
		actionSuperseded: true,
	};
	const toastKeys: Record<RegenerateToastKey, true> = {
		started: true,
		alreadyQueued: true,
		alreadyRunning: true,
		liveRunUnknown: true,
	};

	it("defines every key the mappers return, in both locales", () => {
		for (const messages of [en, de] as unknown as Messages[]) {
			const feedback =
				messages.projects.proposalArtifact.generationFeedback;
			for (const key of [...Object.keys(refusalKinds), "openCatalog"]) {
				expect(feedback[key]).toBeTruthy();
			}
			const toast = messages.projects.documents.regenerateToast;
			for (const key of Object.keys(toastKeys)) {
				expect(toast[key]).toBeTruthy();
			}
		}
	});

	it("says a joined run did not take the new instructions", () => {
		const [enMessages, deMessages] = [en, de] as unknown as Messages[];
		expect(
			enMessages.projects.documents.regenerateToast.alreadyRunning,
		).toContain("new instructions were not applied");
		expect(
			deMessages.projects.documents.regenerateToast.alreadyRunning,
		).toContain("neue Anweisungen wurden nicht übernommen");
	});
});
