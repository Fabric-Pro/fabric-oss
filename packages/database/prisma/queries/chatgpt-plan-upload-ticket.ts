/**
 * The single-purpose ticket `fabric connect chatgpt` uses to upload a ChatGPT
 * plan sign-in (Fizzy #2939).
 *
 * A signed-in person approves the connection on the `/connect/chatgpt` page;
 * the server mints a ticket bound to that person and the organizations they
 * ticked — or, for `--shared`, to one organization they administer — and
 * hands it to the CLI through its loopback callback. The ticket
 * authorises exactly one thing — storing that person's plan sign-in, once,
 * within ten minutes — so the CLI needs no API key and no OAuth scope.
 *
 * Stored in the auth library's generic `verification` table under a
 * namespaced identifier, the same shape as the organization deletion token,
 * but keyed by the ticket's SHA-256 so a database read never yields a usable
 * ticket.
 */
import { createHash, randomBytes } from "node:crypto";
import { db } from "../client";

const TICKET_TTL_MS = 10 * 60_000;
const IDENTIFIER_PREFIX = "chatgpt-plan-upload";

/** A person's own plan, for the organizations they ticked. */
export interface ChatGptPlanUserUploadTicketPayload {
	/** Absent on tickets minted before shared accounts existed. */
	kind?: "user";
	userId: string;
	/** Organizations the person ticked; the flag is re-checked at upload. */
	organizationIds: string[];
}

/**
 * A shared account for one organization (Fizzy #2770), approved by one of its
 * admins or owners; the role and both flags are re-checked at upload.
 */
export interface ChatGptPlanOrgUploadTicketPayload {
	kind: "org";
	/** The admin who approved, recorded as the account's connector. */
	userId: string;
	organizationId: string;
}

export type ChatGptPlanUploadTicketPayload =
	| ChatGptPlanUserUploadTicketPayload
	| ChatGptPlanOrgUploadTicketPayload;

function identifierFor(ticket: string): string {
	return `${IDENTIFIER_PREFIX}-${createHash("sha256").update(ticket).digest("hex")}`;
}

export async function createChatGptPlanUploadTicket(
	payload: ChatGptPlanUploadTicketPayload,
): Promise<{ ticket: string; expiresAt: Date }> {
	const ticket = randomBytes(32).toString("base64url");
	const expiresAt = new Date(Date.now() + TICKET_TTL_MS);
	await db.verification.create({
		data: {
			identifier: identifierFor(ticket),
			value: JSON.stringify(payload),
			expiresAt,
		},
	});
	return { ticket, expiresAt };
}

/**
 * Spends a ticket, exactly once. The row is deleted before the payload is
 * returned, so two concurrent uploads cannot both succeed, and an expired
 * ticket is removed and refused. Every failure is `null`: the caller must not
 * tell an unknown ticket from a spent or expired one.
 */
export async function consumeChatGptPlanUploadTicket(
	ticket: string,
): Promise<ChatGptPlanUploadTicketPayload | null> {
	if (!ticket) {
		return null;
	}
	const row = await db.verification.findFirst({
		where: { identifier: identifierFor(ticket) },
		select: { id: true, value: true, expiresAt: true },
	});
	if (!row) {
		return null;
	}
	const { count } = await db.verification.deleteMany({
		where: { id: row.id },
	});
	if (count === 0 || row.expiresAt.getTime() <= Date.now()) {
		return null;
	}
	try {
		return parseTicketPayload(JSON.parse(row.value));
	} catch {
		return null;
	}
}

function parseTicketPayload(
	value: unknown,
): ChatGptPlanUploadTicketPayload | null {
	const parsed = value as {
		kind?: unknown;
		userId?: unknown;
		organizationId?: unknown;
		organizationIds?: unknown;
	} | null;
	if (typeof parsed?.userId !== "string") {
		return null;
	}
	if (parsed.kind === "org") {
		return typeof parsed.organizationId === "string"
			? {
					kind: "org",
					userId: parsed.userId,
					organizationId: parsed.organizationId,
				}
			: null;
	}
	if (
		(parsed.kind !== undefined && parsed.kind !== "user") ||
		!Array.isArray(parsed.organizationIds)
	) {
		return null;
	}
	return {
		userId: parsed.userId,
		organizationIds: parsed.organizationIds as string[],
	};
}
