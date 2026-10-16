"use client";

import { CheckCircle2, XCircle } from "lucide-react";
import {
	Confirmation,
	ConfirmationAction,
	ConfirmationActions,
	ConfirmationDescription,
	ConfirmationIcon,
	ConfirmationRequest,
	ConfirmationTitle,
} from "../../../../../components/ai-elements/confirmation";
import {
	approveLabel,
	type ChatConfirmationRequest,
	confirmationDescription,
	confirmationTitle,
	hasBlockingProblems,
} from "../../lib/chat-confirmation";
import { ConfirmationDetails } from "./ConfirmationDetails";

interface ChatConfirmationCardProps {
	request: ChatConfirmationRequest;
	/** A turn is running: neither answer can be taken until it ends. */
	busy: boolean;
	onApprove: () => void;
	onDecline: () => void;
}

/**
 * The card for a tool that needs the person's yes (create, edit, publish, pause
 * or run a workflow, give a page tools, any other): the title and body come from
 * the request and its draft, never from which tool it is.
 */
export function ChatConfirmationCard({
	request,
	busy,
	onApprove,
	onDecline,
}: ChatConfirmationCardProps) {
	const description = confirmationDescription(request);
	return (
		<Confirmation approvalState="requested" className="mt-3">
			<ConfirmationTitle>
				<ConfirmationIcon />
				{confirmationTitle(request)}
			</ConfirmationTitle>
			{description && (
				<ConfirmationDescription>{description}</ConfirmationDescription>
			)}
			<ConfirmationRequest>
				<ConfirmationDetails request={request} />
				<ConfirmationActions>
					<ConfirmationAction
						onClick={onApprove}
						disabled={busy || hasBlockingProblems(request)}
						className="bg-green-600 hover:bg-green-700 text-white"
					>
						<CheckCircle2 className="h-4 w-4 mr-2" />
						{approveLabel(request)}
					</ConfirmationAction>
					<ConfirmationAction
						onClick={onDecline}
						disabled={busy}
						variant="outline"
						className="border-red-300 text-destructive hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950"
					>
						<XCircle className="h-4 w-4 mr-2" />
						Cancel
					</ConfirmationAction>
				</ConfirmationActions>
			</ConfirmationRequest>
		</Confirmation>
	);
}
