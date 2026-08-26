import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
	calculateFeatureReadiness,
	type FeatureReadinessSignals,
	getReadinessTierColor,
	ReadinessBar,
} from "../ReadinessBar";

describe("calculateFeatureReadiness — 50/50 Additive Model", () => {
	it("calculates 100% when all baseline signals are present and 0 questions are needed (50% + 50%)", () => {
		const signals: FeatureReadinessSignals = {
			hasFullSpec: true,
			hasAcceptanceCriteria: true,
			blockingGapCount: 0,
			isSpecRecentlyUpdated: true,
			hasFunctionalRequirements: true,
			resolvedQuestionsCount: 0,
			openQuestionsCount: 0,
		};
		expect(calculateFeatureReadiness(signals)).toBe(100);
	});

	it("calculates 40% baseline when Spec, AC, No Gaps, Recency exist (no FRs) and 0 of 4 questions answered", () => {
		const signals: FeatureReadinessSignals = {
			hasFullSpec: true,
			hasAcceptanceCriteria: true,
			blockingGapCount: 0,
			isSpecRecentlyUpdated: true,
			hasFunctionalRequirements: false,
			resolvedQuestionsCount: 0,
			openQuestionsCount: 4,
		};
		expect(calculateFeatureReadiness(signals)).toBe(40);
	});

	it("calculates 65% when 2 of 4 questions are resolved (50% of 50 = 25% + 40% baseline)", () => {
		const signals: FeatureReadinessSignals = {
			hasFullSpec: true,
			hasAcceptanceCriteria: true,
			blockingGapCount: 0,
			isSpecRecentlyUpdated: true,
			hasFunctionalRequirements: false,
			resolvedQuestionsCount: 2,
			openQuestionsCount: 2,
		};
		expect(calculateFeatureReadiness(signals)).toBe(65);
	});

	it("calculates 30% when blocking gap exists (+0% for gap)", () => {
		const signals: FeatureReadinessSignals = {
			hasFullSpec: true,
			hasAcceptanceCriteria: true,
			blockingGapCount: 1,
			isSpecRecentlyUpdated: true,
			hasFunctionalRequirements: false,
			resolvedQuestionsCount: 0,
			openQuestionsCount: 4,
		};
		expect(calculateFeatureReadiness(signals)).toBe(30);
	});

	it("calculates 20% for a newly created empty feature (20% baseline, 0% questions)", () => {
		const signals: FeatureReadinessSignals = {
			hasFullSpec: false,
			hasAcceptanceCriteria: false,
			blockingGapCount: 0,
			isSpecRecentlyUpdated: true,
			hasFunctionalRequirements: false,
			resolvedQuestionsCount: 0,
			openQuestionsCount: 0,
		};
		expect(calculateFeatureReadiness(signals)).toBe(20);
	});

	it("calculates 100% for BUG when overview, fix ACs, expected & actual results, no gaps, and recency are present", () => {
		const signals: FeatureReadinessSignals = {
			storyKind: "BUG",
			hasFullSpec: true,
			hasAcceptanceCriteria: true,
			hasExpectedResult: true,
			hasActualResult: true,
			blockingGapCount: 0,
			needsMoreInfo: false,
			isSpecRecentlyUpdated: true,
			hasFunctionalRequirements: false,
			resolvedQuestionsCount: 0,
			openQuestionsCount: 0,
		};
		expect(calculateFeatureReadiness(signals)).toBe(100);
	});

	it("calculates 95% for BUG when Expected Result (+5%) is present but Actual Result (+0%) is missing", () => {
		const signals: FeatureReadinessSignals = {
			storyKind: "BUG",
			hasFullSpec: true,
			hasAcceptanceCriteria: true,
			hasExpectedResult: true,
			hasActualResult: false,
			blockingGapCount: 0,
			needsMoreInfo: false,
			isSpecRecentlyUpdated: true,
			hasFunctionalRequirements: false,
			resolvedQuestionsCount: 0,
			openQuestionsCount: 0,
		};
		expect(calculateFeatureReadiness(signals)).toBe(95);
	});

	it("calculates 40% for BUG when needsMoreInfo is true (+0% for gaps/triage)", () => {
		const signals: FeatureReadinessSignals = {
			storyKind: "BUG",
			hasFullSpec: true,
			hasAcceptanceCriteria: true,
			hasExpectedResult: true,
			hasActualResult: true,
			blockingGapCount: 0,
			needsMoreInfo: true,
			isSpecRecentlyUpdated: true,
			hasFunctionalRequirements: false,
			resolvedQuestionsCount: 0,
			openQuestionsCount: 4,
		};
		expect(calculateFeatureReadiness(signals)).toBe(40);
	});

	it("ignores needsMoreInfo flag for FEATURE storyKind (does not penalize converted features)", () => {
		const signals: FeatureReadinessSignals = {
			storyKind: "FEATURE",
			hasFullSpec: true,
			hasAcceptanceCriteria: true,
			hasFunctionalRequirements: true,
			blockingGapCount: 0,
			needsMoreInfo: true, // leftover flag from bug conversion
			isSpecRecentlyUpdated: true,
			resolvedQuestionsCount: 0,
			openQuestionsCount: 0,
		};
		expect(calculateFeatureReadiness(signals)).toBe(100);
	});
});

describe("getReadinessTierColor — Option A 5-Tier Status Colors with Semantic CSS Tokens", () => {
	it("returns bg-success for 100% (Fully Ready)", () => {
		expect(getReadinessTierColor(100)).toBe("bg-success");
	});

	it("returns bg-success/80 for 75-99% (Nearly Ready)", () => {
		expect(getReadinessTierColor(80)).toBe("bg-success/80");
		expect(getReadinessTierColor(75)).toBe("bg-success/80");
	});

	it("returns bg-highlight for 50-74% (In Progress)", () => {
		expect(getReadinessTierColor(65)).toBe("bg-highlight");
		expect(getReadinessTierColor(50)).toBe("bg-highlight");
	});

	it("returns bg-highlight/75 for 25-49% (Early Maturation)", () => {
		expect(getReadinessTierColor(40)).toBe("bg-highlight/75");
		expect(getReadinessTierColor(25)).toBe("bg-highlight/75");
	});

	it("returns bg-destructive for 0-24% (Not Ready)", () => {
		expect(getReadinessTierColor(20)).toBe("bg-destructive");
		expect(getReadinessTierColor(0)).toBe("bg-destructive");
	});
});

describe("ReadinessBar Component", () => {
	const defaultSignals: FeatureReadinessSignals = {
		hasFullSpec: true,
		hasAcceptanceCriteria: true,
		blockingGapCount: 0,
		isSpecRecentlyUpdated: true,
		hasFunctionalRequirements: true,
		resolvedQuestionsCount: 0,
		openQuestionsCount: 0,
	};

	it("renders progressbar with correct ARIA attributes and percentage label", () => {
		render(<ReadinessBar signals={defaultSignals} />);

		const progressbar = screen.getByRole("progressbar");
		expect(progressbar).toBeInTheDocument();
		expect(progressbar).toHaveAttribute("aria-valuenow", "100");
		expect(progressbar).toHaveAttribute(
			"aria-label",
			"Spec Readiness: 100%",
		);
		expect(screen.getByText("Spec Readiness")).toBeInTheDocument();
		expect(screen.getByText("100%")).toBeInTheDocument();
	});

	it("renders AI Mode toggle button and switches label to AI Readiness when active", () => {
		render(
			<ReadinessBar
				signals={defaultSignals}
				isAiMode={true}
				aiResult={{
					aiReadinessScore: 85,
					tierLabel: "Nearly Ready",
					rationale: "High spec clarity and testability",
					strengths: ["Clear ACs"],
					gaps: ["1 open question"],
				}}
			/>,
		);

		const progressbar = screen.getByRole("progressbar");
		expect(progressbar).toBeInTheDocument();
		expect(progressbar).toHaveAttribute("aria-valuenow", "85");
		expect(screen.getByText("AI Readiness")).toBeInTheDocument();
		expect(screen.getByText("85%")).toBeInTheDocument();
	});
});
