"use client";

import { useChatgptPlanSpentAction } from "@saas/shared/components/copilot/use-chatgpt-plan-spent-action";
import { DeferredResponse as Response } from "../../../../../components/ai-elements/deferred-response";
import type { DataAnalystTurn } from "../../lib/data-analyst-turn";
import { AnsweredByModel } from "../FabricChat/shared/AnsweredByModel";
import { ChatFailureNotice } from "../FabricChat/shared/ChatFailureNotice";
import { ToolCallList } from "../FabricChat/shared/ToolCallList";

const NO_REMOTE_IMAGES = { img: () => null };

export function DataAnalystAssistantTurn({
	turn,
	organizationId,
}: {
	turn: DataAnalystTurn;
	organizationId: string;
}) {
	const planSpentAction = useChatgptPlanSpentAction();
	return (
		<>
			<ToolCallList toolCalls={turn.toolCalls} />
			{turn.text && (
				<Response
					components={NO_REMOTE_IMAGES}
					streaming={turn.status === "running"}
				>
					{turn.text}
				</Response>
			)}
			{turn.text && <AnsweredByModel model={turn.model} />}
			{turn.error && turn.planSpent && (
				<ChatFailureNotice
					error={turn.error}
					action={planSpentAction(turn.planSpent, organizationId)}
				/>
			)}
		</>
	);
}
