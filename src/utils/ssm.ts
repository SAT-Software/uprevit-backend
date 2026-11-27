import { GetParameterCommand, ParameterNotFound, SSMClient } from '@aws-sdk/client-ssm';

const SSM_CACHE_TTL_MS = 5 * 60 * 1000;

const ssm = new SSMClient({});
const ssmCache = new Map<string, { value: string; expiresAt: number }>();

export const readSecureParameter = async (name: string | undefined): Promise<string> => {
	const parameterName = name?.trim();
	if (!parameterName) return '';

	const cached = ssmCache.get(parameterName);
	if (cached && cached.expiresAt > Date.now()) return cached.value;

	let value = '';
	try {
		const response = await ssm.send(new GetParameterCommand({ Name: parameterName, WithDecryption: true }));
		value = response.Parameter?.Value?.trim() ?? '';
	} catch (error) {
		if (!(error instanceof ParameterNotFound)) throw error;
	}

	ssmCache.set(parameterName, { value, expiresAt: Date.now() + SSM_CACHE_TTL_MS });
	return value;
};
