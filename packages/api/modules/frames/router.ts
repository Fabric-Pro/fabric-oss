import {
	createFrameFromTemplateProcedure,
	createFrameProcedure,
	deleteFrameProcedure,
	duplicateFrameProcedure,
	editFrameStringProcedure,
	getFrameHistoryProcedure,
	getFrameProcedure,
	inviteFrameByEmailProcedure,
	listFrameGrantsProcedure,
	listFramesForStoryProcedure,
	listFramesProcedure,
	listFrameTemplatesProcedure,
	publishFrameProcedure,
	revertFrameProcedure,
	revokeFrameInviteProcedure,
	revokeFrameShareProcedure,
	shareFrameProcedure,
	updateFrameProcedure,
	validateFrameCodeProcedure,
} from "./procedures";
import {
	createFrameTemplateProcedure,
	getFrameTemplateProcedure,
	validateFrameDocumentProcedure,
} from "./procedures/authoring";
import {
	applyFrameBrandingProcedure,
	getFrameBrandingProcedure,
} from "./procedures/branding";
import {
	cancelFrameExportProcedure,
	downloadFrameExportProcedure,
	getFrameExportProcedure,
	startFrameExportProcedure,
} from "./procedures/exports";

import {
	applyFrameChangeProcedure,
	approveFrameRevisionProcedure,
	dismissFrameChangeProcedure,
	getFrameChangeProcedure,
	getFrameReviewProcedure,
	listFrameChangesProcedure,
	proposeFrameChangeProcedure,
} from "./procedures/reviews";

export const framesRouter = {
	getTemplate: getFrameTemplateProcedure,
	createTemplate: createFrameTemplateProcedure,
	validateDocument: validateFrameDocumentProcedure,
	proposeChange: proposeFrameChangeProcedure,
	listChanges: listFrameChangesProcedure,
	getChange: getFrameChangeProcedure,
	applyChange: applyFrameChangeProcedure,
	dismissChange: dismissFrameChangeProcedure,
	getReview: getFrameReviewProcedure,
	approveRevision: approveFrameRevisionProcedure,
	branding: {
		get: getFrameBrandingProcedure,
		apply: applyFrameBrandingProcedure,
	},
	startExport: startFrameExportProcedure,
	getExport: getFrameExportProcedure,
	cancelExport: cancelFrameExportProcedure,
	downloadExport: downloadFrameExportProcedure,
	create: createFrameProcedure,
	createFromTemplate: createFrameFromTemplateProcedure,
	delete: deleteFrameProcedure,
	duplicate: duplicateFrameProcedure,
	get: getFrameProcedure,
	list: listFramesProcedure,
	// Project-scoped frames attached to a story (plan Slice 3)
	listForStory: listFramesForStoryProcedure,
	update: updateFrameProcedure,
	// Code validation
	validate: validateFrameCodeProcedure,
	// Edit/Revert
	editString: editFrameStringProcedure,
	revert: revertFrameProcedure,
	getHistory: getFrameHistoryProcedure,
	// Legacy sharing (to be deprecated)
	publish: publishFrameProcedure,
	revokeShare: revokeFrameShareProcedure,
	// New multi-scope sharing
	share: shareFrameProcedure,
	invite: inviteFrameByEmailProcedure,
	revokeInvite: revokeFrameInviteProcedure,
	listGrants: listFrameGrantsProcedure,
	// Templates
	listTemplates: listFrameTemplatesProcedure,
};
