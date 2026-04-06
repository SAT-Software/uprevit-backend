# Local Product Export Testing Guide

This guide explains how to test the async product export flow locally (enqueue -> worker -> download).

## What Was Fixed

These changes were made to resolve the local SQS URL issue:

- Added `ExportJobQueueUrl` parameter in `template.yaml`.
- `EnqueueProductExportFunction` now uses `ExportJobQueueUrl` when provided (local/dev), and falls back to queue `Ref` in cloud.
- Added strict validation in `src/utils/exportQueue.ts` to fail fast if `EXPORT_JOB_QUEUE_URL` is not a full URL.
- Updated local scripts to consistently pass local env/parameter overrides.

## Why The Earlier Error Happened

Error seen:

- `Invalid URL` with input `ProductExportJobQueue`

Cause:

- Local runtime was receiving the CloudFormation logical token (`ProductExportJobQueue`) instead of a real SQS URL.

## Prerequisites

- Docker running (required for `sam local ...`).
- AWS profile with access to SQS + S3.
- Existing SQS queue URL (example placeholder):
  - `<SQS_QUEUE_URL>`
- Existing buckets:
  - uploads bucket (source images)
  - exports bucket (generated files)

## Required Local Config

In `env.json`, keep values under `Parameters` with Lambda environment variable names, which is the format AWS documents for `sam local ... --env-vars`:

- `MONGODB_URI`
- `DB_NAME`
- `USER_POOL_ID`
- `CLIENT_ID`
- `UPLOADS_BUCKET`
- `EXPORTS_BUCKET`
- `EXPORT_JOB_QUEUE_URL`

You can start from `env.example.json` and create your local ignored `env.json` from it.

Note: the local startup helper also normalizes older `env.json` files that still use legacy keys like `MongoDbUri` and `UserPoolId`.

## Start Backend Locally

From your local backend repo root (or run the same npm script from your own project root/scripts):

```bash
cd <project-root>
npm run start:local
```

If code/template changed and you need built artifacts for explicit invoke, run:

```bash
AWS_PROFILE=<your-aws-profile> sam build -t template.yaml --cached --parallel
```

## End-to-End Local Test Flow

### 1) Enqueue job from UI

- Trigger PDF/Excel export from product page.
- Confirm job appears as `queued` on `/products/exports`.

### 2) Pull one message from SQS

Set your queue URL once for the terminal session:

```bash
export SQS_QUEUE_URL="<SQS_QUEUE_URL>"
```

```bash
AWS_PROFILE=<your-aws-profile> aws sqs receive-message \
  --queue-url "$SQS_QUEUE_URL" \
  --max-number-of-messages 1 \
  --message-attribute-names All \
  --attribute-names All \
  --region us-east-1 > /tmp/export-msg.json
```

### 3) Convert to SAM event format

```bash
python3 - <<'PY'
import json
d = json.load(open('/tmp/export-msg.json'))
if 'Messages' not in d or not d['Messages']:
    print('NO_MESSAGE')
    raise SystemExit(1)
m = d['Messages'][0]
event = {
  "Records": [{
    "messageId": m["MessageId"],
    "body": m["Body"],
    "attributes": {
      "ApproximateReceiveCount": m.get("Attributes", {}).get("ApproximateReceiveCount", "1")
    }
  }]
}
json.dump(event, open('events/product-export-job.json', 'w'), indent=2)
print('EVENT_READY')
PY
```

### 4) Invoke worker locally

Prepare the normalized local env file first:

```bash
npm run prepare:sam-env
```

Use built template for worker invoke:

```bash
AWS_PROFILE=<your-aws-profile> sam local invoke ProcessProductExportJobFunction \
  -t .aws-sam/build/template.yaml \
  --event events/product-export-job.json \
  --env-vars .sam-local-env.json
```

### 5) Validate output

- Refresh `/products/exports`.
- Job should become `completed` (or `failed` with reason).
- Download should work.

## Common Troubleshooting

### `Invalid URL` / `QueueDoesNotExist`

- Check `EXPORT_JOB_QUEUE_URL` in `env.json`.
- Verify queue URL and region with AWS CLI.

### `Cannot find module 'processExportJob'`

- Worker invoke was run against source template instead of built template.
- Rebuild and use `-t .aws-sam/build/template.yaml` for `sam local invoke`.

### Download opens in browser instead of direct download

- Backend now signs export URLs with `Content-Disposition: attachment`.
- Frontend now triggers download using an anchor with `download` attribute.
