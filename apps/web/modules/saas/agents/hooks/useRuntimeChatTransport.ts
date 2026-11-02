"use client";

import type { FeatureFlagKey } from "@repo/utils/feature-flag-registry";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { useState } from "react";

/** Which transport a request/reply chat runs over: its own route, or the agent runtime. */
export type RuntimeChatTransport = "legacy" | "runtime";

/**
 * The transport a request/reply chat (an `InProcessEngine` agent) uses,
 * chosen when the chat mounts and kept for its lifetime, as
 * `useDirectChatStream` chooses: the agent runtime while the chat's rollout
 * `flag` is on for the organization on screen, else the chat's own route.
 *
 * Unlike the Direct and Orchestrator chats, nothing is saved, so no role is
 * required; a viewer with no organization on screen stays on the route,
 * because every runtime request runs in an organization.
 */
export function useRuntimeChatTransport(
	flag: FeatureFlagKey,
): RuntimeChatTransport {
	const enabled = useFeatureFlag(flag);
	const { organizationId } = useOrganizationContext();
	const [transport] = useState<RuntimeChatTransport>(() =>
		enabled && organizationId !== null ? "runtime" : "legacy",
	);
	return transport;
}
