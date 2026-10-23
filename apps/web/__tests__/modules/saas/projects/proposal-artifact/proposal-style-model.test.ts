/**
 * The Style tab's pure model (Fizzy #2801, Fizzy #2946): the draft a saved
 * style loads into, the checks a save makes before the request, the
 * validation code a refused save carries, the alternatives each proposer
 * colour offers against the draft as it would be stored, and how a fetch of
 * the recipient's website reads at a given moment.
 */

import { BRAND_FETCH_RUNNING_TTL_MS } from "@repo/utils/proposal-artifact/brand-sources";
import {
	alternativesFor,
	hasEntries,
	type ProposerSources,
	proposalStyleDraftFrom,
	proposerColorSources,
	styleErrorOf,
	suggestionViewOf,
	validateProposalStyleDraft,
} from "@saas/projects/components/proposal-artifact/proposal-style-model";
import { describe, expect, it } from "vitest";
import { orpcError } from "./proposal-artifact-fixtures";

const NOW = new Date("2026-10-07T12:00:00.000Z");

/** Where the proposer's colours come from: by default only the Brand kit holds any. */
function proposer(
	overrides: {
		primary?: Partial<ProposerSources["primary"]>;
		accents?: Partial<ProposerSources["accents"]>;
	} = {},
): ProposerSources {
	return {
		primary: {
			resolved: { value: "#1f4e79", source: "BRAND_KIT" },
			inherited: { value: "#1f4e79", source: "BRAND_KIT" },
			style: null,
			brandKit: "#1f4e79",
			vendorSite: null,
			alternatives: [],
			...overrides.primary,
		},
		accents: {
			resolved: { value: ["#475569"], source: "DEFAULT" },
			inherited: { value: ["#475569"], source: "DEFAULT" },
			style: [],
			brandKit: [],
			vendorSite: [],
			alternatives: [],
			...overrides.accents,
		},
		logo: { source: "DEFAULT", present: false },
		hero: { source: "DEFAULT", present: false },
		fonts: {
			display: { family: "Inter", source: "DEFAULT", hasFile: false },
			body: { family: "Inter", source: "DEFAULT", hasFile: false },
		},
	};
}

function attempt(
	overrides: Partial<{
		status: "RUNNING" | "SUCCEEDED" | "FAILED";
		failureCode: "unreachable" | "no_logo" | "no_colors" | null;
		requestedAt: Date;
		result: {
			name: string | null;
			colors: string[];
			logoUrl: string | null;
			alternatives: Array<"name" | "colors" | "logo">;
		} | null;
	}> = {},
) {
	return {
		requestId: "request-1",
		website: "https://example.com",
		status: "SUCCEEDED" as const,
		failureCode: null,
		requestedAt: new Date(NOW.getTime() - 5000),
		fetchedAt: NOW,
		result: {
			name: "Example Corp",
			colors: ["#123456"],
			logoUrl: null,
			alternatives: [],
		},
		...overrides,
	};
}

describe("proposalStyleDraftFrom", () => {
	it("starts empty without a saved style", () => {
		expect(proposalStyleDraftFrom(undefined)).toEqual({
			styleDirection: "",
			primary: [],
			accents: [],
			autoVisuals: true,
		});
	});

	it("loads a saved style as entries, a missing primary as none", () => {
		expect(
			proposalStyleDraftFrom({
				styleDirection: "Calm and factual",
				primaryColor: null,
				accentColors: ["#ff8800"],
				autoVisuals: false,
				updatedAt: NOW,
			}),
		).toEqual({
			styleDirection: "Calm and factual",
			primary: [],
			accents: ["#ff8800"],
			autoVisuals: false,
		});
	});
});

describe("validateProposalStyleDraft", () => {
	it("trims the direction, normalizes colours and drops blanks", () => {
		expect(
			validateProposalStyleDraft({
				styleDirection: "  Lead with the timeline  ",
				primary: ["#ABC"],
				accents: ["#FF8800", "", "  "],
				autoVisuals: false,
			}),
		).toEqual({
			ok: true,
			value: {
				styleDirection: "Lead with the timeline",
				primaryColor: "#aabbcc",
				accentColors: ["#ff8800"],
				autoVisuals: false,
			},
		});
	});

	it("clears an empty direction and an empty primary", () => {
		expect(
			validateProposalStyleDraft({
				styleDirection: "   ",
				primary: [],
				accents: [],
				autoVisuals: true,
			}),
		).toEqual({
			ok: true,
			value: {
				styleDirection: null,
				primaryColor: null,
				accentColors: [],
				autoVisuals: true,
			},
		});
	});

	it("refuses what the server refuses", () => {
		expect(
			validateProposalStyleDraft({
				styleDirection: "x".repeat(501),
				primary: [],
				accents: [],
				autoVisuals: true,
			}),
		).toEqual({ ok: false, error: "directionTooLong" });
		expect(
			validateProposalStyleDraft({
				styleDirection: "x".repeat(500),
				primary: [],
				accents: [],
				autoVisuals: true,
			}).ok,
		).toBe(true);
		expect(
			validateProposalStyleDraft({
				styleDirection: "",
				primary: ["red"],
				accents: [],
				autoVisuals: true,
			}),
		).toEqual({ ok: false, error: "invalidColor" });
		expect(
			validateProposalStyleDraft({
				styleDirection: "",
				primary: [],
				accents: ["#12345g"],
				autoVisuals: true,
			}),
		).toEqual({ ok: false, error: "invalidColor" });
		expect(
			validateProposalStyleDraft({
				styleDirection: "",
				primary: [],
				accents: ["#111111", "#222222", "#333333", "#444444"],
				autoVisuals: true,
			}),
		).toEqual({ ok: false, error: "tooManyAccentColors" });
	});
});

describe("styleErrorOf", () => {
	it("reads one of the style's own validation codes off a refused save", () => {
		expect(
			styleErrorOf(
				orpcError("BAD_REQUEST", "Not valid", {
					code: "tooManyAccentColors",
				}),
			),
		).toBe("tooManyAccentColors");
	});

	it("is null for any other code, or any other refusal", () => {
		expect(
			styleErrorOf(
				orpcError("BAD_REQUEST", "Not valid", {
					code: "somethingElse",
				}),
			),
		).toBeNull();
		expect(styleErrorOf(orpcError("BAD_REQUEST", "Not valid"))).toBeNull();
		expect(
			styleErrorOf(
				orpcError("INTERNAL_SERVER_ERROR", "Failed", {
					code: "invalidColor",
				}),
			),
		).toBeNull();
		expect(styleErrorOf(new Error("Network"))).toBeNull();
	});
});

describe("alternativesFor", () => {
	const inherited = { source: "BRAND_KIT" as const, value: "#1f4e79" };
	const candidates = [
		{ source: "BRAND_KIT" as const, value: "#1f4e79" },
		{ source: "VENDOR_SITE" as const, value: "#2a9d8f" },
	];

	it("offers nothing for a draft that does not parse", () => {
		expect(alternativesFor(undefined, inherited, candidates)).toEqual([]);
	});

	it("compares an inheriting draft with what it inherits", () => {
		expect(alternativesFor(null, inherited, candidates)).toEqual([
			{ source: "VENDOR_SITE", value: "#2a9d8f" },
		]);
	});

	it("compares an override with every source, skipping empty ones and repeats", () => {
		expect(
			alternativesFor("#000000", inherited, [
				...candidates,
				{ source: "VENDOR_SITE", value: null },
			]),
		).toEqual(candidates);
		expect(
			alternativesFor("#1f4e79", inherited, [
				{ source: "BRAND_KIT", value: "#1f4e79" },
				{ source: "VENDOR_SITE", value: "#1f4e79" },
			]),
		).toEqual([]);
	});
});

describe("proposerColorSources", () => {
	it("shows what the primary inherits, as the server reads it", () => {
		expect(proposerColorSources("primary", [], proposer())).toEqual({
			inherited: { source: "BRAND_KIT", value: ["#1f4e79"] },
			alternatives: [],
		});
	});

	it("offers each source's differing value against a typed override, as stored", () => {
		const sources = proposer({ primary: { vendorSite: "#2a9d8f" } });
		expect(
			proposerColorSources("primary", ["#000000"], sources).alternatives,
		).toEqual([
			{ source: "BRAND_KIT", value: ["#1f4e79"] },
			{ source: "VENDOR_SITE", value: ["#2a9d8f"] },
		]);
		// `#1F4E79` is the Brand kit's colour once stored.
		expect(
			proposerColorSources("primary", ["#1F4E79"], sources).alternatives,
		).toEqual([{ source: "VENDOR_SITE", value: ["#2a9d8f"] }]);
	});

	it("offers nothing while a typed colour does not parse", () => {
		expect(
			proposerColorSources(
				"primary",
				["#12"],
				proposer({ primary: { vendorSite: "#2a9d8f" } }),
			).alternatives,
		).toEqual([]);
	});

	it("reads the accents the same way, never offering the neutral default", () => {
		const sources = proposer({
			accents: { vendorSite: ["#ff8800", "#00aa55"] },
		});
		expect(proposerColorSources("accents", [], sources)).toEqual({
			inherited: { source: "DEFAULT", value: ["#475569"] },
			alternatives: [
				{ source: "VENDOR_SITE", value: ["#ff8800", "#00aa55"] },
			],
		});
		expect(
			proposerColorSources("accents", ["#FF8800", "#00AA55", ""], sources)
				.alternatives,
		).toEqual([]);
	});
});

describe("hasEntries", () => {
	it("counts only an entry with something typed in it", () => {
		expect(hasEntries([])).toBe(false);
		expect(hasEntries(["", "  "])).toBe(false);
		expect(hasEntries(["", "#1"])).toBe(true);
	});
});

describe("suggestionViewOf", () => {
	it("reads a request on its way as running, and no attempt as none", () => {
		expect(suggestionViewOf(attempt(), true, NOW)).toEqual({
			kind: "running",
		});
		expect(suggestionViewOf(null, false, NOW)).toEqual({ kind: "none" });
	});

	it("reads a RUNNING attempt as timed out once it outlives its lifetime", () => {
		const running = attempt({ status: "RUNNING", result: null });
		expect(suggestionViewOf(running, false, NOW)).toEqual({
			kind: "running",
		});
		expect(
			suggestionViewOf(
				running,
				false,
				new Date(
					running.requestedAt.getTime() +
						BRAND_FETCH_RUNNING_TTL_MS +
						1,
				),
			),
		).toEqual({ kind: "failed", code: "timed_out" });
	});

	it("reads a failure that found nothing usable as nothing found", () => {
		for (const failureCode of ["no_logo", "no_colors"] as const) {
			expect(
				suggestionViewOf(
					attempt({ status: "FAILED", failureCode, result: null }),
					false,
					NOW,
				),
			).toEqual({ kind: "nothingFound" });
		}
		expect(
			suggestionViewOf(
				attempt({
					status: "FAILED",
					failureCode: "unreachable",
					result: null,
				}),
				false,
				NOW,
			),
		).toEqual({ kind: "failed", code: "unreachable" });
	});

	it("reads a success by what it found", () => {
		const found = attempt({
			result: {
				name: "Example Corp",
				colors: ["#ff0000"],
				logoUrl: null,
				alternatives: ["colors"],
			},
		});
		expect(suggestionViewOf(found, false, NOW)).toEqual({
			kind: "found",
			requestId: "request-1",
			result: found.result,
		});
		expect(suggestionViewOf(attempt(), false, NOW)).toEqual({
			kind: "matches",
		});
		expect(
			suggestionViewOf(
				attempt({
					result: {
						name: null,
						colors: [],
						logoUrl: null,
						alternatives: [],
					},
				}),
				false,
				NOW,
			),
		).toEqual({ kind: "nothingFound" });
		expect(suggestionViewOf(attempt({ result: null }), false, NOW)).toEqual(
			{ kind: "none" },
		);
	});
});
