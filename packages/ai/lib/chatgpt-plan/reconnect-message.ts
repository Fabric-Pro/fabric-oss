/**
 * What every surface says when a member's plan is turned on but its sign-in
 * no longer works. Fabric never falls back to the organization's API billing
 * on its own; the member reconnects or switches the organization back.
 *
 * Kept free of imports so Temporal workflow code can bundle it: `oauth.ts`
 * imports `node:crypto`, which the workflow sandbox rejects.
 */
export const CHATGPT_PLAN_RECONNECT_REQUIRED_MESSAGE =
	"Your ChatGPT connection needs to be reconnected. Reconnect it, or switch this organization to organization API billing.";
