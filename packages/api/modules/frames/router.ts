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

export const framesRouter = {
	create: createFrameProcedure,
	createFromTemplate: createFrameFromTemplateProcedure,
	delete: deleteFrameProcedure,
	duplicate: duplicateFrameProcedure,
	get: getFrameProcedure,
	list: listFramesProcedure,
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
