import type { AiErrorToastCopy } from "@saas/shared/lib/ai-error-message";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatgptPlanSpentAction } from "../use-chatgpt-plan-spent-action";

const m = vi.hoisted(() => ({
	push: vi.fn(),
	setUse: vi.fn(),
	activeOrganization: { id: "org-example-1", slug: "example-org" },
}));
vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({ activeOrganization: m.activeOrganization }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: m.push }) }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { users: { chatgptPlan: { setOrganizationUse: m.setUse } } },
}));
beforeEach(() => {
	vi.clearAllMocks();
	m.setUse.mockResolvedValue({});
});
const copy = (flags: Partial<AiErrorToastCopy>): AiErrorToastCopy => ({
	title: "Plan spent",
	description: "Wait",
	...flags,
});

describe("shared plan-spent actions", () => {
	it("offers the billing switch only for the active organization", async () => {
		const { result } = renderHook(useChatgptPlanSpentAction);
		expect(
			result.current(
				copy({ planApiBillingActionable: true }),
				"org-other",
			),
		).toBeUndefined();
		const action = result.current(
			copy({
				planApiBillingActionable: true,
				planPersonalKeyActionable: true,
			}),
			"org-example-1",
		);
		expect(action?.label).toBe("useOrganizationBilling");
		await act(async () => {
			action?.onClick();
		});
		expect(m.setUse).toHaveBeenCalledWith({ enabled: false });
		expect(m.push).not.toHaveBeenCalled();
	});
	it("links to the Personal tab only when billing was not offered", () => {
		const { result } = renderHook(useChatgptPlanSpentAction);
		const action = result.current(
			copy({ planPersonalKeyActionable: true }),
			"org-example-1",
		);
		expect(action?.label).toBe("configurePersonalFallback");
		action?.onClick();
		expect(m.push).toHaveBeenCalledWith(
			"/app/example-org/settings/ai-providers?tab=personal",
		);
		expect(result.current(copy({}), "org-example-1")).toBeUndefined();
	});
});
