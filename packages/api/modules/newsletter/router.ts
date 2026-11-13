import { confirmSubscriptionProcedure } from "./procedures/confirm-subscription";
import { approveSendProcedure } from "./procedures/sends-approve";
import { chatDeliveriesProcedure } from "./procedures/sends-chat-deliveries";
import { addImageProcedure } from "./procedures/sends-images-add";
import { captureImageProcedure } from "./procedures/sends-images-capture";
import { createImageUploadUrlProcedure } from "./procedures/sends-images-create-upload-url";
import { includeAllImagesProcedure } from "./procedures/sends-images-include-all";
import { regenerateImageProcedure } from "./procedures/sends-images-regenerate";
import { removeImageProcedure } from "./procedures/sends-images-remove";
import { replaceImageProcedure } from "./procedures/sends-images-replace";
import { unpublishImagesProcedure } from "./procedures/sends-images-unpublish";
import { updateImageProcedure } from "./procedures/sends-images-update";
import { listSendsProcedure } from "./procedures/sends-list";
import { memberGetSendProcedure } from "./procedures/sends-member-get";
import { memberListSendsProcedure } from "./procedures/sends-member-list";
import { listPendingSendsProcedure } from "./procedures/sends-pending-list";
import { recipientPreviewProcedure } from "./procedures/sends-recipient-preview";
import { rejectSendProcedure } from "./procedures/sends-reject";
import { sendNowProcedure } from "./procedures/sends-send-now";
import { getSettingsProcedure } from "./procedures/settings-get";
import { regenerateEmbedTokenProcedure } from "./procedures/settings-regenerate-token";
import { updateSettingsProcedure } from "./procedures/settings-update";
import { subscribeToNewsletter } from "./procedures/subscribe-to-newsletter";
import { addSubscribersProcedure } from "./procedures/subscribers-add";
import { listSubscribersProcedure } from "./procedures/subscribers-list";
import { removeSubscriberProcedure } from "./procedures/subscribers-remove";
import { setSubscriberExcludedProcedure } from "./procedures/subscribers-set-excluded";
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
		setExcluded: setSubscriberExcludedProcedure,
	},
	sends: {
		list: listSendsProcedure,
		memberList: memberListSendsProcedure,
		memberGet: memberGetSendProcedure,
		sendNow: sendNowProcedure,
		recipientPreview: recipientPreviewProcedure,
		pending: listPendingSendsProcedure,
		approve: approveSendProcedure,
		reject: rejectSendProcedure,
		chatDeliveries: chatDeliveriesProcedure,
		images: {
			createUploadUrl: createImageUploadUrlProcedure,
			add: addImageProcedure,
			replace: replaceImageProcedure,
			update: updateImageProcedure,
			includeAll: includeAllImagesProcedure,
			remove: removeImageProcedure,
			regenerate: regenerateImageProcedure,
			capture: captureImageProcedure,
			unpublish: unpublishImagesProcedure,
		},
	},
	unsubscribe: unsubscribeProcedure,
};
