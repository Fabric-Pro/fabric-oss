import type { LimitSignal } from "@repo/ai/limits";
import type { OrchestratorStepResult } from "@repo/temporal";
import type { z } from "zod";
import type {
	DoneTurnEvent,
	TurnErrorEvent,
	WorkflowErrorEvent,
} from "../../../../app/api/agents/fabric-ai/stream/turn-events";
import type { AssertAssignable } from "./chat-stream-protocol";
import type {
	directStreamEventSchema,
	limitSchema,
} from "./direct-stream-protocol";
import type { orchestratorStreamEventSchema } from "./orchestrator-stream-protocol";

type DirectInput = z.input<typeof directStreamEventSchema>;
type OrchestratorInput = z.input<typeof orchestratorStreamEventSchema>;
export type LimitInput = AssertAssignable<
	LimitSignal,
	z.input<typeof limitSchema>
>;
export type DirectDone = AssertAssignable<DoneTurnEvent, DirectInput>;
export type DirectError = AssertAssignable<
	TurnErrorEvent | WorkflowErrorEvent,
	DirectInput
>;
export type OrchestratorError = AssertAssignable<
	WorkflowErrorEvent,
	OrchestratorInput
>;
type CompletedTool = OrchestratorStepResult["toolCalls"][number];
type ToolPayload<K extends string> = {
	type: K;
	toolCallId: CompletedTool["id"];
	toolName: CompletedTool["name"];
	status: CompletedTool["status"];
	args: CompletedTool["args"];
} & (K extends "tool_result" ? { result: CompletedTool["result"] } : unknown);
export type ToolStart = AssertAssignable<
	ToolPayload<"tool_start">,
	OrchestratorInput
>;
export type ToolInput = AssertAssignable<
	ToolPayload<"tool_input">,
	OrchestratorInput
>;
export type ToolResult = AssertAssignable<
	ToolPayload<"tool_result">,
	OrchestratorInput
>;

type AssertTrue<T extends true> = T;
// Assignment alone permits missing optional keys; this also checks key completeness.
type SameKeys<A, B> = [
	Exclude<keyof A, keyof B>,
	Exclude<keyof B, keyof A>,
] extends [never, never]
	? true
	: false;
export type LimitSchemaKeys = AssertTrue<
	SameKeys<z.output<typeof limitSchema>, LimitSignal>
>;
export type LimitBudgetSchemaKeys = AssertTrue<
	SameKeys<
		NonNullable<z.output<typeof limitSchema>["budget"]>,
		NonNullable<LimitSignal["budget"]>
	>
>;
export type LimitInputPreservesKeys = AssertTrue<
	[LimitInput] extends [never] ? false : true
>;
export type DirectDonePreservesKeys = AssertTrue<
	[DirectDone] extends [never] ? false : true
>;
export type DirectErrorPreservesKeys = AssertTrue<
	[DirectError] extends [never] ? false : true
>;
export type OrchestratorErrorPreservesKeys = AssertTrue<
	[OrchestratorError] extends [never] ? false : true
>;
export type ToolStartPreservesKeys = AssertTrue<
	[ToolStart] extends [never] ? false : true
>;
export type ToolInputPreservesKeys = AssertTrue<
	[ToolInput] extends [never] ? false : true
>;
export type ToolResultPreservesKeys = AssertTrue<
	[ToolResult] extends [never] ? false : true
>;
