"use server";

import { auth } from "@repo/auth";
import { headers } from "next/headers";

type InvitationActionResult =
	| { success: true }
	| { success: false; code: "INVITATION_NOT_FOUND" | "UNKNOWN_ERROR" };

export async function acceptOrganizationInvitation(
	invitationId: string,
): Promise<InvitationActionResult> {
	try {
		await auth.api.acceptInvitation({
			body: { invitationId },
			headers: await headers(),
		});
		return { success: true };
	} catch (e) {
		const message =
			e && typeof e === "object" && "message" in e
				? (e.message as string)
				: "";
		if (message.toLowerCase().includes("invitation not found")) {
			return { success: false, code: "INVITATION_NOT_FOUND" };
		}
		return { success: false, code: "UNKNOWN_ERROR" };
	}
}

export async function rejectOrganizationInvitation(
	invitationId: string,
): Promise<InvitationActionResult> {
	try {
		await auth.api.rejectInvitation({
			body: { invitationId },
			headers: await headers(),
		});
		return { success: true };
	} catch (e) {
		const message =
			e && typeof e === "object" && "message" in e
				? (e.message as string)
				: "";
		if (message.toLowerCase().includes("invitation not found")) {
			return { success: false, code: "INVITATION_NOT_FOUND" };
		}
		return { success: false, code: "UNKNOWN_ERROR" };
	}
}
