import { confirmSubscriptionProcedure } from "./procedures/confirm-subscription";
import { approveSendProcedure } from "./procedures/sends-approve";
import { chatDeliveriesProcedure } from "./procedures/sends-chat-deliveries";
import { listSendsProcedure } from "./procedures/sends-list";
import { memberListSendsProcedure } from "./procedures/sends-member-list";
import { listPendingSendsProcedure } from "./procedures/sends-pending-list";
import { rejectSendProcedure } from "./procedures/sends-reject";
import { sendNowProcedure } from "./procedures/sends-send-now";
import { getSettingsProcedure } from "./procedures/settings-get";
import { regenerateEmbedTokenProcedure } from "./procedures/settings-regenerate-token";
import { updateSettingsProcedure } from "./procedures/settings-update";
import { subscribeToNewsletter } from "./procedures/subscribe-to-newsletter";
import { addSubscribersProcedure } from "./procedures/subscribers-add";
import { listSubscribersProcedure } from "./procedures/subscribers-list";
import { removeSubscriberProcedure } from "./procedures/subscribers-remove";
import { unsubscribeProcedure } from "./procedures/unsubscribe";

export const newsletterRouter = {
	subscribe: subscribeToNewsletter, // public double opt-in for the Fabric-main release-notes newsletter
	confirmSubscription: confirmSubscriptionProcedure,
	settings: {
		get: getSettingsProcedure,
		update: updateSettingsProcedure,
		regenerateEmbedToken: regenerateEmbedTokenProcedure,
	},
	subscribers: {
		list: listSubscribersProcedure,
		add: addSubscribersProcedure,
		remove: removeSubscriberProcedure,
	},
	sends: {
		list: listSendsProcedure,
		memberList: memberListSendsProcedure,
		sendNow: sendNowProcedure,
		pending: listPendingSendsProcedure,
		approve: approveSendProcedure,
		reject: rejectSendProcedure,
		chatDeliveries: chatDeliveriesProcedure,
	},
	unsubscribe: unsubscribeProcedure,
};
