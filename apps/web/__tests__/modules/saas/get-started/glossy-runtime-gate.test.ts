import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	GET_STARTED_PAGES,
	type GsRuntimeGates,
	pageComponentsFor,
	pageForTab,
} from "../../../../modules/saas/get-started/lib/get-started-registry";
import {
	ONBOARDING_REQUIRED_AREAS,
	ONBOARDING_STEPS,
	type OnboardingStep,
	resolveTourSteps,
} from "../../../../modules/saas/get-started/lib/tour-steps";

/**
 * Glossy editions (Fizzy #2589) are scoped to named organizations through the
 * org-scopable `GLOSSY_EDITION` flag, and they are not a tab: they hang off a
 * Proposal or Business Case on the Documents tab. So the gate reaches Get
 * Started as ONE gated component of the Documents page tour and ONE gated step
 * of the guided tour — never as a gate on the Documents page itself.
 */

const OFF: GsRuntimeGates = {
	publishingSuite: false,
	todoList: false,
	glossyEdition: false,
	proposalArtifact: false,
};
const ON: GsRuntimeGates = { ...OFF, glossyEdition: true };

const ANCHOR = "documents-glossy";

const documentsPage = () => {
	const page = GET_STARTED_PAGES.find((p) => p.tab === "documents");
	if (!page) {
		throw new Error("the Documents page tour is missing");
	}
	return page;
};
const componentIds = (gates: GsRuntimeGates) =>
	pageComponentsFor(documentsPage(), gates).map((c) => c.id);
const ids = (steps: readonly OnboardingStep[]) => steps.map((s) => s.id);
const allVisible = () => true;

describe("Get Started — Glossy edition page-tour component", () => {
	it("declares the runtime gate on the component, not on the Documents page", () => {
		const component = documentsPage().components.find(
			(c) => c.id === "documents-glossy",
		);
		expect(component?.runtimeGate).toBe("glossyEdition");
		// The anchor is on Proposal / Business Case cards only, so even with
		// the gate on the page tour must be able to skip it.
		expect(component?.conditional).toBe(true);
		expect(component?.anchor).toBe(ANCHOR);
		// Gating the page would take the whole Documents tour away from every
		// organization that is not enrolled.
		expect(documentsPage().runtimeGate).toBeUndefined();
		expect(pageForTab("documents", OFF)?.tab).toBe("documents");
		expect(pageForTab("documents", ON)?.tab).toBe("documents");
	});

	it("is withheld with the gate off and walked with it on", () => {
		expect(componentIds(OFF)).not.toContain("documents-glossy");
		expect(componentIds(ON)).toContain("documents-glossy");
	});

	it("leaves the ungated Documents components untouched", () => {
		// Negative control: only the gated component moves between the two.
		expect(
			componentIds(ON).filter((id) => id !== "documents-glossy"),
		).toEqual(componentIds(OFF));
		expect(componentIds(OFF)).toEqual([
			"documents-create",
			"documents-list",
		]);
	});

	it("does not answer to the other gates", () => {
		const everyOtherGateOn: GsRuntimeGates = {
			publishingSuite: true,
			todoList: true,
			glossyEdition: false,
			proposalArtifact: true,
		};
		expect(componentIds(everyOtherGateOn)).not.toContain(
			"documents-glossy",
		);
	});
});

describe("Get Started — Glossy edition guided-tour step", () => {
	const step = ONBOARDING_STEPS.find((s) => s.id === "glossy");

	it("targets the same anchor as the page-tour component, on the Documents tab", () => {
		expect(step?.runtimeGate).toBe("glossyEdition");
		expect(step?.target).toEqual({
			kind: "projectComponent",
			tab: "documents",
			anchorId: ANCHOR,
			side: "bottom",
		});
	});

	it("is not a required area — an unenrolled organization never has it", () => {
		expect(ONBOARDING_REQUIRED_AREAS).not.toContain("glossy");
	});

	it("is dropped with the gate off or unset", () => {
		expect(
			ids(
				resolveTourSteps({
					hasProject: true,
					isTabVisible: allVisible,
				}),
			),
		).not.toContain("glossy");
		expect(
			ids(
				resolveTourSteps({
					hasProject: true,
					isTabVisible: allVisible,
					gates: { todoList: true, glossyEdition: false },
				}),
			),
		).not.toContain("glossy");
	});

	it("follows Documents with the gate on, independently of To Do", () => {
		const steps = ids(
			resolveTourSteps({
				hasProject: true,
				isTabVisible: allVisible,
				gates: { todoList: false, glossyEdition: true },
			}),
		);
		expect(steps).toContain("glossy");
		expect(steps).not.toContain("todos");
		expect(steps[steps.indexOf("documents") + 1]).toBe("glossy");
	});

	it("leaves with the Documents tab when that tab is hidden", () => {
		const steps = ids(
			resolveTourSteps({
				hasProject: true,
				isTabVisible: (tab) => tab !== "documents",
				gates: { todoList: true, glossyEdition: true },
			}),
		);
		expect(steps).not.toContain("documents");
		expect(steps).not.toContain("glossy");
	});

	it("is collapsed away like any project step when the viewer has no project", () => {
		const steps = ids(
			resolveTourSteps({
				hasProject: false,
				isTabVisible: allVisible,
				gates: { todoList: false, glossyEdition: true },
			}),
		);
		expect(steps).not.toContain("glossy");
		expect(steps).toContain("overview");
	});
});

describe("Get Started — Glossy edition copy", () => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const repoRoot = path.resolve(here, "../../../../../..");
	const load = (locale: string) =>
		JSON.parse(
			readFileSync(
				path.resolve(
					repoRoot,
					`packages/i18n/translations/${locale}.json`,
				),
				"utf8",
			),
		) as {
			onboarding: {
				tour: {
					steps: Record<string, { title: string; body: string }>;
				};
			};
		};

	// The guided tour is English-only: German has no `onboarding.tour` block
	// and falls back to English for every step, this one included, rather
	// than showing one German step inside an English tour.
	it("has a guided-tour title and body in English, and no German-only step", () => {
		const copy = load("en").onboarding.tour.steps.glossy;
		expect(copy?.title).toBeTruthy();
		expect(copy?.body).toBeTruthy();
		expect(
			(load("de") as { onboarding: { tour?: unknown } }).onboarding.tour,
		).toBeUndefined();
	});

	it("keeps the concept: an edition of a Proposal or Business Case that never changes it", () => {
		const component = documentsPage().components.find(
			(c) => c.id === "documents-glossy",
		);
		const tourBody = load("en").onboarding.tour.steps.glossy.body;
		for (const body of [component?.body ?? "", tourBody]) {
			expect(body).toContain("Proposal or Business Case");
			expect(body).toContain("never changes the source document");
		}
	});

	it("keeps the artifact-mode copy in English only, with the same concept for a Business Case", () => {
		const copy = load("en").onboarding.tour.steps.glossyProposalArtifact;
		expect(copy?.title).toBeTruthy();
		const component = pageComponentsFor(documentsPage(), {
			...ON,
			proposalArtifact: true,
		}).find((c) => c.id === "documents-glossy");
		for (const body of [component?.body ?? "", copy?.body ?? ""]) {
			expect(body).toContain("A Business Case can also become");
			expect(body).toContain("never changes the source document");
			// What a Proposal has instead of a Glossy edition.
			expect(body).toContain(
				"Main Document, Internal Analysis and Style tabs",
			);
			// No promise of a Glossy edition the Proposal no longer offers.
			expect(body).not.toContain("Proposal or Business Case");
		}
	});
});

/**
 * Under the `PROPOSAL_ARTIFACT` rollout gate (Fizzy #2801) a Proposal is
 * written client-ready and offers no Glossy entry unless a legacy edition was
 * published. Glossy itself stays for Business Case, so the gate hides no
 * component or step: it changes what they say, so neither points an
 * artifact-mode viewer at a Glossy entry their Proposals no longer carry.
 */
describe("Get Started — Glossy copy under the Proposal artifact gate", () => {
	const ARTIFACT: GsRuntimeGates = { ...ON, proposalArtifact: true };
	const glossyComponent = (gates: GsRuntimeGates) =>
		pageComponentsFor(documentsPage(), gates).find(
			(c) => c.id === "documents-glossy",
		);
	const glossyStep = (
		gates: Parameters<typeof resolveTourSteps>[0]["gates"],
	) =>
		resolveTourSteps({
			hasProject: true,
			isTabVisible: allVisible,
			gates,
		}).find((s) => s.id === "glossy");

	it("swaps the page-tour component's copy, not the component", () => {
		const classic = glossyComponent(ON);
		const artifact = glossyComponent(ARTIFACT);

		expect(classic?.body).toContain("Proposal or Business Case");
		expect(artifact?.body).not.toBe(classic?.body);
		expect(artifact?.body).toContain("Internal Analysis");
		// Same component, same anchor, still conditional: the anchor now sits
		// on Business Case cards and on Proposals with a published edition.
		expect(artifact).toMatchObject({
			id: "documents-glossy",
			anchor: ANCHOR,
			conditional: true,
		});
		expect(componentIds(ARTIFACT)).toEqual(componentIds(ON));
	});

	it("does not reopen the component with the Glossy gate off", () => {
		expect(componentIds({ ...OFF, proposalArtifact: true })).not.toContain(
			"documents-glossy",
		);
	});

	it("leaves every other component's copy alone", () => {
		const others = (gates: GsRuntimeGates) =>
			pageComponentsFor(documentsPage(), gates).filter(
				(c) => c.id !== "documents-glossy",
			);
		expect(others(ARTIFACT)).toEqual(others(ON));
	});

	it("points the guided-tour step at the artifact copy, keeping its id and place", () => {
		const classic = glossyStep({
			todoList: false,
			glossyEdition: true,
			proposalArtifact: false,
		});
		const artifact = glossyStep({
			todoList: false,
			glossyEdition: true,
			proposalArtifact: true,
		});

		expect(classic?.copyId).toBeUndefined();
		expect(artifact?.copyId).toBe("glossyProposalArtifact");
		expect(artifact?.target).toEqual(classic?.target);
		const steps = ids(
			resolveTourSteps({
				hasProject: true,
				isTabVisible: allVisible,
				gates: {
					todoList: false,
					glossyEdition: true,
					proposalArtifact: true,
				},
			}),
		);
		expect(steps[steps.indexOf("documents") + 1]).toBe("glossy");
	});

	it("keeps the step's own copy when the artifact gate is unsupplied", () => {
		// Fail-safe: a caller that could not resolve the flag gets today's
		// copy, which is right for every organization not enrolled.
		expect(glossyStep({ glossyEdition: true })?.copyId).toBeUndefined();
	});

	it("does not bring the step back with the Glossy gate off", () => {
		expect(
			glossyStep({
				todoList: true,
				glossyEdition: false,
				proposalArtifact: true,
			}),
		).toBeUndefined();
	});
});
