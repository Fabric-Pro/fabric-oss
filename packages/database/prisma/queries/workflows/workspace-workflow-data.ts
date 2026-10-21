import { db } from "../../client";
import {
	getPageRecordWithin,
	PAGE_WRITE_TRANSACTION,
	type PageRecordScope,
	type PageRecordWrite,
	setPageRecordsWithin,
	translatePageRecordWriteFailure,
} from "../frame-page-records";
import {
	assertWorkspaceWorkflowBindingWithin,
	type WorkspaceWorkflowRunGuard,
} from "./workspace-workflow-binding";

interface WorkspaceWorkflowRecord {
	binding: WorkspaceWorkflowRunGuard;
	collection: string;
	key: string;
	scope: PageRecordScope;
}

export async function getWorkspaceWorkflowRecord(
	input: WorkspaceWorkflowRecord,
) {
	return db.$transaction(async (tx) => {
		await assertWorkspaceWorkflowBindingWithin(tx, input.binding);
		return getPageRecordWithin(tx, {
			frameId: input.binding.workspaceFrameId,
			organizationId: input.binding.organizationId,
			viewerUserId: input.binding.userId,
			collection: input.collection,
			key: input.key,
			scope: input.scope,
		});
	}, PAGE_WRITE_TRANSACTION);
}

/** The grant locks precede the page lock and remain held until the write commits. */
export async function setWorkspaceWorkflowRecord(
	input: WorkspaceWorkflowRecord & {
		value: PageRecordWrite["value"];
		expectedVersion: number;
	},
) {
	return db
		.$transaction(async (tx) => {
			await assertWorkspaceWorkflowBindingWithin(tx, input.binding);
			return setPageRecordsWithin(tx, {
				frameId: input.binding.workspaceFrameId,
				organizationId: input.binding.organizationId,
				actorUserId: input.binding.userId,
				collection: input.collection,
				records: [
					{
						key: input.key,
						scope: input.scope,
						value: input.value,
						expectedVersion: input.expectedVersion,
					},
				],
			});
		}, PAGE_WRITE_TRANSACTION)
		.catch(translatePageRecordWriteFailure);
}
