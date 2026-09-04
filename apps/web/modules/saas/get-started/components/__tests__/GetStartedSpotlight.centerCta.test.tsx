/**
 * The centered tour card's "Take me there" link (Fizzy #2361).
 *
 * A centered step has no anchor to spotlight, so before this it could only
 * ever be a dead-end message. The two key steps need to be actionable — a
 * slide that says "you need an AI provider key" and cannot take you to the
 * page that adds one is exactly the confusion it is meant to remove.
 *
 * Every other suite in this folder stubs the spotlight out to test the
 * controller around it. This one renders the real component, because the
 * branch under test IS the rendering: the CTA button only appears when
 * `ctaHref` is set, and the centered path is the only path that can set it
 * without an anchor.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KeyIcon } from "lucide-react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ----------------------------------------------------------------------------
// Mocks — defined BEFORE the import of GetStartedSpotlight.
// ----------------------------------------------------------------------------

const BASE_PATH = "/app/example-org";

/** Flipped per test — the AI-provider step's destination depends on it. */
let isOrganizationAdmin = true;

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		basePath: BASE_PATH,
		isOrganizationAdmin,
	}),
	useOrganizationId: () => "org-1",
}));

const push = vi.fn();
vi.mock("next/navigation", () => ({
	usePathname: () => "/app/example-org",
	useRouter: () => ({ push }),
}));

/** Only reached by project-scoped steps; centered steps never call it. */
const listProjects = vi.fn();
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: { list: (...args: unknown[]) => listProjects(...args) },
	},
}));

import { ONBOARDING_STEPS, type OnboardingStep } from "../../lib/tour-steps";
import { GetStartedSpotlight } from "../GetStartedSpotlight";

type Navigate = NonNullable<
	Extract<OnboardingStep["target"], { kind: "center" }>["navigate"]
>;

const centered = (navigate?: Navigate): OnboardingStep => ({
	id: "aiKey",
	area: "aiKey",
	icon: KeyIcon,
	target: navigate ? { kind: "center", navigate } : { kind: "center" },
});

/** The real step, so these tests break if its destinations ever change. */
const aiKeyStep = () =>
	ONBOARDING_STEPS.find((s) => s.id === "aiKey") as OnboardingStep;

function renderStep(step: OnboardingStep) {
	return render(
		<GetStartedSpotlight
			steps={[step]}
			index={0}
			onNext={vi.fn()}
			onBack={vi.fn()}
			onSkipStep={vi.fn()}
			onGoTo={vi.fn()}
			onDismiss={vi.fn()}
			onFinish={vi.fn()}
		/>,
	);
}

/**
 * The global next-intl mock echoes the key, so the CTA's label is the key
 * itself. Asserting on the key rather than the English string keeps this test
 * about the branch, not about the copy.
 */
const CTA = "onboarding.tour.goTo";

beforeEach(() => {
	vi.clearAllMocks();
	isOrganizationAdmin = true;
});

describe("GetStartedSpotlight — centered step CTA", () => {
	it("renders the link when the step names a destination", async () => {
		renderStep(centered((base) => `${base}/settings/ai-providers`));

		expect(await screen.findByText(CTA)).toBeInTheDocument();
	});

	it("builds the destination from the active workspace base path", async () => {
		renderStep(centered((base) => `${base}/settings/ai-providers`));

		await userEvent.click(await screen.findByText(CTA));

		expect(push).toHaveBeenCalledWith(`${BASE_PATH}/settings/ai-providers`);
	});

	it("renders no link for a centered step with no destination", async () => {
		// `welcome` is this step: a greeting with nowhere to send anyone. It
		// must keep rendering exactly as it did before `navigate` existed.
		renderStep(centered());

		// Wait for the card itself, then assert the CTA is absent — asserting
		// absence before the component has resolved would pass for the wrong
		// reason. A one-step tour is both first and last, so its forward
		// control is "Done".
		expect(
			await screen.findByText("onboarding.tour.done"),
		).toBeInTheDocument();
		expect(screen.queryByText(CTA)).not.toBeInTheDocument();
	});

	it("takes an admin to the organization AI provider page", async () => {
		renderStep(aiKeyStep());

		await userEvent.click(await screen.findByText(CTA));

		expect(push).toHaveBeenCalledWith(`${BASE_PATH}/settings/ai-providers`);
	});

	it("takes a member to the personal page they can actually submit", async () => {
		// The organization page renders read-only for everyone but an admin.
		// Landing a member there would tell them to add a key and then hand
		// them a form they cannot use.
		isOrganizationAdmin = false;
		renderStep(aiKeyStep());

		await userEvent.click(await screen.findByText(CTA));

		expect(push).toHaveBeenCalledWith(
			`${BASE_PATH}/settings/account/ai-providers`,
		);
	});

	it("never consults the project lookup for a centered step", async () => {
		renderStep(centered((base) => `${base}/settings/api-keys`));

		expect(await screen.findByText(CTA)).toBeInTheDocument();
		expect(listProjects).not.toHaveBeenCalled();
	});
});
