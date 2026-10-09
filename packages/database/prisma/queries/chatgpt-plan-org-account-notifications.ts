/**
 * Tells an organization's owners and admins — and whoever connected the
 * account — that a ChatGPT plan account it shares needs to be reconnected
 * (Fizzy #2770). Lives in `@repo/database` because the status flip happens in
 * `@repo/ai`, which `@repo/api`'s notification service depends on.
 *
 * Firing once per flip is the caller's job: `plan-credentials.ts` calls this
 * only when its ACTIVE → NEEDS_RECONNECT update changed the row, and nothing
 * sets the account ACTIVE again but a new sign-in. The dedupe key is a second
 * guard: an unread row for the same account is not stacked.
 *
 * In-app only, like the other `@repo/database` writers: email is an opt-in
 * channel that only `createNotification` dispatches. Never throws.
 */
import { db, NotificationCategory, NotificationType } from "../client";

const NOTIFIABLE_ROLES = ["owner", "admin"] as const;

/** Where the accounts are listed and reconnected. Context-relative. */
const RECONNECT_LINK = "settings/ai-providers";

export async function notifyChatGptPlanOrgAccountNeedsReconnect(input: {
	organizationId: string;
	accountId: string;
}): Promise<void> {
	try {
		const account = await db.chatGptPlanOrgAccount.findFirst({
			where: {
				id: input.accountId,
				organizationId: input.organizationId,
			},
			select: { label: true, email: true, connectedByUserId: true },
		});
		if (!account) {
			return;
		}
		const members = await db.member.findMany({
			where: { organizationId: input.organizationId },
			select: { userId: true, role: true },
		});
		const recipients = new Set(
			members
				.filter(
					(member) =>
						(NOTIFIABLE_ROLES as readonly string[]).includes(
							member.role,
						) || member.userId === account.connectedByUserId,
				)
				.map((member) => member.userId),
		);
		const name = account.email
			? `${account.label} (${account.email})`
			: account.label;
		await Promise.all(
			[...recipients].map((userId) =>
				writeRow(input, userId, name).catch(() => undefined),
			),
		);
	} catch (error) {
		console.warn(
			"[ChatGptPlanOrgAccountNotification] reconnect notice failed",
			{ accountId: input.accountId },
			error,
		);
	}
}

async function writeRow(
	input: { organizationId: string; accountId: string },
	userId: string,
	name: string,
): Promise<void> {
	try {
		await db.notification.create({
			data: {
				userId,
				organizationId: input.organizationId,
				type: NotificationType.CHATGPT_PLAN_ACCOUNT_NEEDS_RECONNECT,
				category: NotificationCategory.SYSTEM,
				title: "Shared ChatGPT plan account needs reconnecting",
				snippet: `${name} was signed out by OpenAI and serves nobody until it is reconnected in AI Providers.`,
				link: RECONNECT_LINK,
				payload: { accountId: input.accountId, accountName: name },
				dedupeKey: `chatgptPlanAccountReconnect:${input.accountId}:${userId}`,
			},
		});
	} catch (error) {
		if ((error as { code?: string } | null)?.code === "P2002") {
			return;
		}
		throw error;
	}
}
