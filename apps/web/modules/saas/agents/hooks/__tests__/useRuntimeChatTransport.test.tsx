import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRuntimeChatTransport } from "../useRuntimeChatTransport";

const m = vi.hoisted(() => ({
	enabled: true,
	contextId: null as string | null,
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => m.enabled,
}));
vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({
		activeOrganization: m.contextId === null ? null : { id: m.contextId },
	}),
}));
vi.mock("@saas/organizations/lib/api", () => ({
	useOrganizationListQuery: vi.fn(),
}));

beforeEach(() => {
	m.enabled = true;
	m.contextId = null;
});

describe("runtime chat organization selection", () => {
	it.each([
		{
			contextId: null,
			explicitId: undefined,
			enabled: true,
			expected: "legacy",
		},
		{
			contextId: "org-context",
			explicitId: undefined,
			enabled: true,
			expected: "runtime",
		},
		{
			contextId: "org-context",
			explicitId: null,
			enabled: true,
			expected: "legacy",
		},
		{
			contextId: null,
			explicitId: "org-route",
			enabled: true,
			expected: "runtime",
		},
		{
			contextId: "org-context",
			explicitId: "org-route",
			enabled: true,
			expected: "runtime",
		},
		{
			contextId: null,
			explicitId: "org-route",
			enabled: false,
			expected: "legacy",
		},
	])(
		"uses $expected with $contextId context, $explicitId explicit ID and flag $enabled",
		({ contextId, explicitId, enabled, expected }) => {
			m.contextId = contextId;
			m.enabled = enabled;
			const { result } = renderHook(() =>
				useRuntimeChatTransport(
					"COPILOTKIT_DATA_ANALYST_CHAT",
					explicitId,
				),
			);
			expect(result.current).toBe(expected);
		},
	);

	it.each([false, true])(
		"pins transport with the initial flag %s",
		(enabled) => {
			m.enabled = enabled;
			const { result, rerender } = renderHook(
				({ organizationId }: { organizationId: string | null }) =>
					useRuntimeChatTransport(
						"COPILOTKIT_DATA_ANALYST_CHAT",
						organizationId,
					),
				{ initialProps: { organizationId: "org-route" } },
			);
			expect(result.current).toBe(enabled ? "runtime" : "legacy");
			m.enabled = !enabled;
			rerender({ organizationId: null });
			expect(result.current).toBe(enabled ? "runtime" : "legacy");
		},
	);
});
