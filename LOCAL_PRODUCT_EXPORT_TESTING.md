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
- Existing SQS queue URL (example):
  - `https://sqs.us-east-1.amazonaws.com/940900040930/product-export-job-queue`
- Existing buckets:
  - uploads bucket (source images)
  - exports bucket (generated files)

## Required Local Config

In `env.json`, keep values under `Parameters` with SAM parameter names:

- `MongoDbUri`
- `DbName`
- `UserPoolId`
- `ClientId`
- `UploadsBucket`
- `ExportsBucket`
- `ExportJobQueueUrl`

## Start Backend Locally

From backend root:

```bash
cd /Users/amit/Developer/Startup/uprevit-backend
npm run start:local
```

If code/template changed and you need built artifacts for explicit invoke, run:

```bash
AWS_PROFILE=uprevit-amit sam build -t template.yaml --cached --parallel
```

## End-to-End Local Test Flow

### 1) Enqueue job from UI

- Trigger PDF/Excel export from product page.
- Confirm job appears as `queued` on `/products/exports`.

### 2) Pull one message from SQS

```bash
AWS_PROFILE=uprevit-amit aws sqs receive-message \
  --queue-url https://sqs.us-east-1.amazonaws.com/940900040930/product-export-job-queue \
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

Use built template for worker invoke:

```bash
AWS_PROFILE=uprevit-amit sam local invoke ProcessProductExportJobFunction \
  -t .aws-sam/build/template.yaml \
  --event events/product-export-job.json \
  --env-vars env.json \
  --parameter-overrides "MongoDbUri=<...> DbName=uprevit-test UserPoolId=<...> ClientId=<...> UploadsBucket=uprevit-storage-dev-and-test ExportsBucket=exports-storage-dev-and-test ExportJobQueueUrl=https://sqs.us-east-1.amazonaws.com/940900040930/product-export-job-queue"
```

### 5) Validate output

- Refresh `/products/exports`.
- Job should become `completed` (or `failed` with reason).
- Download should work.

## Common Troubleshooting

### `Invalid URL` / `QueueDoesNotExist`

- Check `ExportJobQueueUrl` in `env.json`.
- Verify queue URL and region with AWS CLI.

### `Cannot find module 'processExportJob'`

- Worker invoke was run against source template instead of built template.
- Rebuild and use `-t .aws-sam/build/template.yaml` for `sam local invoke`.

### Download opens in browser instead of direct download

- Backend now signs export URLs with `Content-Disposition: attachment`.
- Frontend now triggers download using an anchor with `download` attribute.
