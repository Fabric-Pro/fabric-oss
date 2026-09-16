/**
 * The assistant slide as a user actually sees it (Fizzy #2487).
 *
 * The rest of this folder leans on the global next-intl mock, which echoes the
 * key straight back — under it the card renders the literal string
 * "onboarding.tour.steps.assistant.title" and a rename regression is invisible.
 * So this file overrides that mock to resolve against the shipped `en.json`,
 * which is the entire point: `advisor-rename.test.ts` pins the catalogue, and
 * this pins the catalogue reaching the screen.
 *
 * Together they close the gap the step type leaves open — `OnboardingStep`
 * allows inline `title`/`body`, and `GetStartedSpotlight` prefers them over the
 * catalogue, so copy asserted in JSON alone can be shadowed at render time.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// ----------------------------------------------------------------------------
// Mocks — defined BEFORE the import of GetStartedSpotlight.
// ----------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../../../..");

const messages = JSON.parse(
	readFileSync(
		path.resolve(repoRoot, "packages/i18n/translations/en.json"),
		"utf8",
	),
) as Record<string, unknown>;

function lookup(dotted: string): string {
	const value = dotted.split(".").reduce<unknown>((acc, key) => {
		if (acc && typeof acc === "object") {
			return (acc as Record<string, unknown>)[key];
		}
		return undefined;
	}, messages);

	// Falling back to the key keeps unrelated chrome rendering; the assertions
	// below target the two strings this test is actually about.
	return typeof value === "string" ? value : dotted;
}

vi.mock("next-intl", () => {
	const t = (key: string) => lookup(key);
	t.raw = (key: string) => lookup(key);
	return {
		useTranslations: () => t,
		useLocale: () => "en",
		useFormatter: () => ({
			dateTime: (d: Date) => d.toISOString(),
			number: (n: number) => String(n),
			relativeTime: (d: Date) => d.toISOString(),
		}),
		useMessages: () => messages,
		NextIntlClientProvider: ({ children }: { children: React.ReactNode }) =>
			children,
	};
});

const BASE_PATH = "/app/example-org";

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		basePath: BASE_PATH,
		isOrganizationAdmin: true,
	}),
	useOrganizationId: () => "org-1",
}));

vi.mock("next/navigation", () => ({
	usePathname: () => BASE_PATH,
	useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { projects: { list: vi.fn() } },
}));

import { ONBOARDING_STEPS, type OnboardingStep } from "../../lib/tour-steps";
import { GetStartedSpotlight } from "../GetStartedSpotlight";

/** The real step, so this breaks if its copy source or target ever changes. */
const assistantStep = () =>
	ONBOARDING_STEPS.find((s) => s.id === "assistant") as OnboardingStep;

/**
 * The step anchors to the sidebar entry, and the spotlight resolves it with
 * `document.querySelector('[data-onboarding-target="nav-nexus"]')`, waiting on
 * a MutationObserver until it exists. Without the anchor the card never shows.
 */
function mountAnchor() {
	const el = document.createElement("div");
	el.setAttribute("data-onboarding-target", "nav-nexus");
	document.body.appendChild(el);
	return el;
}

describe("GetStartedSpotlight — the assistant slide names Advisor", () => {
	it("renders the Advisor title from the shipped catalogue", async () => {
		mountAnchor();
		render(
			<GetStartedSpotlight
				steps={[assistantStep()]}
				index={0}
				onNext={vi.fn()}
				onBack={vi.fn()}
				onSkipStep={vi.fn()}
				onGoTo={vi.fn()}
				onDismiss={vi.fn()}
				onFinish={vi.fn()}
			/>,
		);

		expect(
			await screen.findByText("Meet Advisor, your AI assistant"),
		).toBeInTheDocument();
	});

	it("renders body copy that names Advisor and never Nexus", async () => {
		mountAnchor();
		render(
			<GetStartedSpotlight
				steps={[assistantStep()]}
				index={0}
				onNext={vi.fn()}
				onBack={vi.fn()}
				onSkipStep={vi.fn()}
				onGoTo={vi.fn()}
				onDismiss={vi.fn()}
				onFinish={vi.fn()}
			/>,
		);

		// Wait for the card before asserting absence, so "no Nexus" cannot pass
		// simply because nothing has rendered yet.
		expect(
			await screen.findByText(/Advisor is your always-on AI teammate/),
		).toBeInTheDocument();
		expect(document.body.textContent).not.toContain("Nexus");
	});
});
