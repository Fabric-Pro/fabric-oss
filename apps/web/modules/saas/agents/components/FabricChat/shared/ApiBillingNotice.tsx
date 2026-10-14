"use client";

import { ReceiptText } from "lucide-react";
import {
	type ChatGptPlanApiBilling,
	chatGptPlanApiBillingNote,
} from "../../../lib/chatgpt-plan-api-billing";

/**
 * Says, under a reply, that it was billed to the organization's API provider
 * because every ChatGPT plan was spent, and when the plans reset (Fizzy #3048).
 */
export function ApiBillingNotice({
	apiBilling,
}: {
	apiBilling: ChatGptPlanApiBilling;
}) {
	return (
		<p
			className="mt-2 flex items-center gap-1.5 text-muted-foreground text-xs"
			data-testid="chatgpt-plan-api-billing-notice"
		>
			<ReceiptText className="size-3 shrink-0" aria-hidden />
			{chatGptPlanApiBillingNote(apiBilling)}
		</p>
	);
}
