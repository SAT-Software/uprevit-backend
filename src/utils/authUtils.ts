import { CognitoJwtVerifier } from 'aws-jwt-verify';
// Replace with your Amazon Cognito user pool ID
const userPoolId = process.env.USER_POOL_ID!;

async function verifyJWT(token: string) {
  try {
    const verifier = CognitoJwtVerifier.create({
      userPoolId,
      tokenUse: 'access', // or 'id' for ID tokens
      clientId: process.env.CLIENT_ID!, // Optional, only if you need to verify the token audience
    });

    const payload = await verifier.verify(token);
    console.log('Decoded JWT:', payload);
  } catch (err) {
    console.error('Error verifying JWT:', err);
  }
}

async function validateRole(token: string, role: string) {
  try {
    const verifier = CognitoJwtVerifier.create({
      userPoolId,
      tokenUse: 'access',
      clientId: process.env.CLIENT_ID!,
    });

    const payload = await verifier.verify(token);
    if (payload['cognito:groups']?.includes(role)) {
      return true;
    }
    return false;
  } catch (err) {
    console.error('Error validating role:', err);
    return false;
  }
}