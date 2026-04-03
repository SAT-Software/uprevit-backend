import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const sourcePath = path.join(repoRoot, 'env.json');
const outputPath = path.join(repoRoot, '.sam-local-env.json');

const legacyKeyMap = {
  MongoDbUri: 'MONGODB_URI',
  DbName: 'DB_NAME',
  UserPoolId: 'USER_POOL_ID',
  ClientId: 'CLIENT_ID',
  UploadsBucket: 'UPLOADS_BUCKET',
  ExportsBucket: 'EXPORTS_BUCKET',
  ExportJobQueueUrl: 'EXPORT_JOB_QUEUE_URL',
};

const requiredGlobalKeys = [
  'MONGODB_URI',
  'DB_NAME',
  'USER_POOL_ID',
  'CLIENT_ID',
];

function normalizeSection(section = {}) {
  return Object.fromEntries(
    Object.entries(section).map(([key, value]) => [legacyKeyMap[key] ?? key, value]),
  );
}

function readSourceEnv() {
  try {
    return JSON.parse(readFileSync(sourcePath, 'utf8'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(
        'Missing env.json. Create it from env.example.json or your local secret source before running local SAM.',
      );
    }

    throw new Error(`Unable to read env.json: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeEnvFile(rawEnv) {
  const normalized = {};

  for (const [sectionName, sectionValue] of Object.entries(rawEnv)) {
    if (!sectionValue || typeof sectionValue !== 'object' || Array.isArray(sectionValue)) {
      normalized[sectionName] = sectionValue;
      continue;
    }

    normalized[sectionName] = normalizeSection(sectionValue);
  }

  if (!normalized.Parameters || typeof normalized.Parameters !== 'object' || Array.isArray(normalized.Parameters)) {
    normalized.Parameters = {};
  }

  const missingKeys = requiredGlobalKeys.filter((key) => !normalized.Parameters[key]);

  if (missingKeys.length > 0) {
    throw new Error(
      `env.json is missing required local env keys under Parameters: ${missingKeys.join(', ')}`,
    );
  }

  return normalized;
}

function main() {
  const rawEnv = readSourceEnv();
  const normalizedEnv = normalizeEnvFile(rawEnv);

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(normalizedEnv, null, 2)}\n`);

  console.log(`Prepared SAM env file at ${path.relative(repoRoot, outputPath)}`);
}

main();
