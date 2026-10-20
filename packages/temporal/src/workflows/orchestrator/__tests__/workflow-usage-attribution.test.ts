import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ enabled: true }));
vi.mock("@temporalio/workflow", () => ({
	patched: vi.fn(() => mocks.enabled),
}));

import {
	secondaryUsageOriginFields,
	secondaryUsageOptionArgs,
	usageOriginFields,
} from "../workflow-usage-attribution";

const input = {
	conversationId: "conversation-example",
	usageFrameId: "frame-example",
	projectId: "project-example",
};

beforeEach(() => {
	mocks.enabled = true;
});

it("attributes new activity payloads to the validated turn origin", () => {
	expect(usageOriginFields(input)).toEqual({
		conversationId: input.conversationId,
		frameId: input.usageFrameId,
		projectId: input.projectId,
	});
	expect(secondaryUsageOriginFields(input)).toEqual({
		usageOrigin: { ...usageOriginFields(input), featureKey: "chat-agent" },
	});
});

it("preserves both pre-patch activity payload shapes during replay", () => {
	mocks.enabled = false;
	expect(usageOriginFields(input)).toEqual({
		conversationId: input.conversationId,
		frameId: input.usageFrameId,
	});
	expect(secondaryUsageOriginFields(input)).toEqual({});
});

it("does not invent an origin for old input without validated origin fields", () => {
	const oldInput = {
		launchWorkspaceId: "placement-only",
		executionId: "execution-only",
		conversationId: undefined,
	};
	expect(secondaryUsageOriginFields(oldInput)).toEqual({});
});

it("retains positional options and the legacy omitted argument during replay", () => {
	expect(secondaryUsageOptionArgs(input, undefined)).toEqual([
		{
			usageConversationId: input.conversationId,
			...secondaryUsageOriginFields(input),
		},
	]);
	mocks.enabled = false;
	expect(secondaryUsageOptionArgs(input, undefined)).toEqual([
		{
			usageConversationId: input.conversationId,
		},
	]);
	expect(
		secondaryUsageOptionArgs({ projectId: input.projectId }, undefined),
	).toEqual([]);
	const turn = {
		cancellationAware: true,
		turnScope: {
			turnId: "turn-example",
			executionId: "execution-example",
			userId: "user-example",
			organizationId: "org-example",
		},
	};
	expect(secondaryUsageOptionArgs({}, turn)).toEqual([
		{ turnScope: turn.turnScope },
	]);
});
