import { FabricLogo } from "@saas/shared/components/FabricLogo";
import { Card } from "@ui/components/card";
import { CircleHelpIcon } from "lucide-react";
import type { ClarificationTurn } from "../../../lib/clarification-turns";
import { Message } from "../../../../../../components/ai-elements/message";

/** One clarification exchange in the Advisor's column. */
export function AnsweredClarification({
	turn,
	answerer = "You",
}: {
	turn: ClarificationTurn;
	answerer?: string;
}) {
	return (
		<Message from="assistant" className="py-2">
			<div className="shrink-0" aria-hidden="true">
				<FabricLogo className="h-8 w-8" size={32} />
			</div>
			<Card
				role="group"
				aria-label="Clarifying question"
				className="min-w-0 flex-1 space-y-1 bg-muted p-3 text-sm text-foreground"
			>
				<p className="flex items-start gap-2">
					<CircleHelpIcon
						className="mt-0.5 size-4 shrink-0"
						aria-hidden="true"
					/>
					<span className="whitespace-pre-wrap break-words">
						<span className="sr-only">Advisor asked: </span>
						{turn.question}
					</span>
				</p>
				<p className="whitespace-pre-wrap break-words pl-6">
					<span
						className="mr-1 text-muted-foreground"
						aria-hidden="true"
					>
						↳ {answerer}:
					</span>
					<span className="sr-only">{answerer} answered: </span>
					<span className="font-medium">{turn.answer}</span>
				</p>
			</Card>
		</Message>
	);
}
