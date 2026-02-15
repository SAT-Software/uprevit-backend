import { enrichItemsWithSignedUrls } from "./s3-storage";

type UserAvatarShape = {
	profileAvatar?: string;
	profileAvatarKey?: string;
};

type WorkspaceLogoShape = {
	logo?: string;
	logoKey?: string;
};

const extractS3Key = (value: unknown): string | undefined => {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	if (!trimmed.startsWith("uploads/")) return undefined;
	return trimmed;
};

export const enrichUsersWithProfileAvatarUrls = async <T extends UserAvatarShape>(
	users: T[],
): Promise<T[]> => {
	if (!users.length) return users;

	const usersWithKeys = users.map((user) => {
		const profileAvatarKey = extractS3Key(user.profileAvatar);
		if (!profileAvatarKey) return user;

		return {
			...user,
			profileAvatarKey,
		};
	});

	return enrichItemsWithSignedUrls({
		items: usersWithKeys,
		getKey: (item) => item.profileAvatarKey,
		setSignedUrl: (item, signedUrl) => ({
			...item,
			profileAvatar: signedUrl,
		}),
	});
};

export const enrichWorkspaceWithLogoUrl = async <T extends WorkspaceLogoShape>(
	workspace: T | null,
): Promise<T | null> => {
	if (!workspace) return workspace;

	const logoKey = extractS3Key(workspace.logo);
	if (!logoKey) return workspace;

	const [workspaceWithSignedLogo] = await enrichItemsWithSignedUrls({
		items: [
			{
				...workspace,
				logoKey,
			},
		],
		getKey: (item) => item.logoKey,
		setSignedUrl: (item, signedUrl) => ({
			...item,
			logo: signedUrl,
		}),
	});

	return workspaceWithSignedLogo ?? workspace;
};
