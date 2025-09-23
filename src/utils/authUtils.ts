import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { CognitoAccessTokenPayload } from 'aws-jwt-verify/jwt-model';
// Replace with your Amazon Cognito user pool ID
const userPoolId = process.env.USER_POOL_ID!;

export type TokenValidationResponse = {
	payload?: CognitoAccessTokenPayload;
	isValid: boolean;
}

export async function verifyJWT(token: string): Promise<TokenValidationResponse> {
  try {
    const verifier = CognitoJwtVerifier.create({
      userPoolId,
      tokenUse: 'access', // or 'id' for ID tokens
      clientId: process.env.CLIENT_ID!, // Optional, only if you need to verify the token audience
    });

    const payload = await verifier.verify(token);
    console.log('Decoded JWT:', payload);
		
		return {payload, isValid: true};
  } catch (err) {
    console.error('Error verifying JWT:', err);
		return {isValid: false};
  }
}

export async function validateRole(token: string, role: string): Promise<TokenValidationResponse> {
  try {
    const verifier = CognitoJwtVerifier.create({
      userPoolId,
      tokenUse: 'access',
      clientId: process.env.CLIENT_ID!,
    });

    const payload = await verifier.verify(token);
    if (payload['cognito:groups']?.includes(role)) {
      return {payload, isValid: true};
    }

    return {isValid: false};
  } catch (err) {
    console.error('Error validating role:', err);
    return {isValid: false};
  }
}