import { ObjectId } from "mongodb";

export type Workspace = {
	_id?: ObjectId;
	workspaceName: string;
	companyName: string;
	companyId: string;
		description: string;
		logo: string;
		plan: string;
		planName: string;
		planId: string;
		planStart: Date;
		planEnd: Date;
		cost: number;
		userIds?: ObjectId[];
}