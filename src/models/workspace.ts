import { ObjectId } from "mongodb";
import type { WorkflowCompletionMode } from './workflow';

export type WorkspaceFreeze = {
	enabled: boolean;
	updatedAt: Date;
	updatedByPlatformAdminId?: ObjectId;
};

export type Workspace = {
	_id?: ObjectId;
	workspaceName: string;
	companyName: string;
	companyId?: string;
	description: string;
	logo: string;
	plan: string;
	planName: string;
	planId: string;
	planStart: Date | null;
	planEnd: Date | null;
	cost: number;
	adminIds?: ObjectId[];
	userIds?: ObjectId[];
	workspaceUsageFreeze?: WorkspaceFreeze;
	workspaceAccessFreeze?: WorkspaceFreeze;
	memberListIncludeInactive?: boolean;
	workflowPrefix?: string;
	defaultWorkflowCompletionMode?: WorkflowCompletionMode;
};
