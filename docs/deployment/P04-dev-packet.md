# P04 development deployment packet

Status: **steps 1 to 3 deployed 2026-11-07 (development, us-east-1) with Josue's approval; steps 4 to 6 not approved.** See the deployment record at the end.

Original status: ready to ship, not approved. No AWS account, region, bootstrap, user, certificate or model has been created or selected by this work. Approval must name the account, region, and each numbered step below.

## 1. Candidate

- Source: branch `p04-backend`. Deployable code is identical to commit `7ae0c5f`; later commits on the branch change documentation only unless the handoff says otherwise.
- Synthesized with `npm run synth` (CDK 2.275.0, Node 22 Lambda runtime, ARM64). Templates are environment-agnostic: no account, region or lookups.
- Lambda bundle asset keys (first 16 hex of the content hash): API `9a16390cd439015d`, Device `c6d09c3eff9a383e`, Dispatcher `aa0af1c20e06bfa6`. Template SHA-256 prefixes: Data `0d97ecccbf9b9d26`, Runtime `f68fc1869106d74d`. Re-synthesize and compare before deploying; any difference means a different candidate.

## 2. Environment inputs still required

| Input | Proposal | Why it matters |
| --- | --- | --- |
| AWS account | A dedicated development account or isolated sandbox | Keeps synthetic test data and IAM changes away from other workloads |
| Region | Choose with P08: a region where the selected Bedrock inference profiles are available (for example `us-west-2` or `us-east-1`) | Tables, bucket and user pool are regional and retained; moving later means migration |
| Deployment role | A CDK deploy role for this account, used through an approved session | `cdk bootstrap` and `cdk deploy` need it |
| Budget alert | An AWS Budget with an owner email, for example USD 10/month | Alarm actions and budget notifications need a named owner (not created by this stack) |
| Alarm owner | Who receives the four alarms | Alarms are created without actions |

Found read-only on 2026-11-07: the available credentials are the team SSO account (`ClippyHackers` permission set). CloudFormation is explicitly denied there in us-east-2 and us-west-2, so **us-east-1 is the only workable region**. us-east-1 has no CDK bootstrap and already contains other teams' DataZone stacks, so it is a shared account. Josue chose to hold off on deployment (2026-11-07). Whether the permission set allows IAM role, KMS, Cognito, IoT and Step Functions creation is unknown until a `cdk deploy` is attempted, so expect possible partial failure and have rollback ready.

## 3. Exact changes, in order (each needs its own approval)

1. **CDK bootstrap** (`npx cdk bootstrap aws://ACCOUNT/REGION`): creates the `CDKToolkit` stack (staging S3 bucket, ECR repository, deploy/lookup/publishing roles). One-time per account and region.
2. **Deploy `ClippyData-dev`** (12 resources, all persistent): one KMS key with rotation and alias `alias/clippy-dev-data`; one private media bucket (KMS, bucket key, TLS-only, Block Public Access, no versioning, no lifecycle expiry, policy denying any `PutObject` without `If-None-Match`); four on-demand DynamoDB tables (`accounts`, `devices`, `journal` with `gsi1`, `operations` with `pending` index, stream `NEW_IMAGE`, TTL `ttl`), deletion protection on, point-in-time recovery off; a Cognito user pool (admin-created users only, Essentials plan, optional TOTP MFA, deletion protection), resource server `clippy` with scope `journal`, a public app client (authorization code with PKCE, no secret, callback `clippy://auth/callback`), and the hosted domain `clippy-dev-ACCOUNT`.
3. **Deploy `ClippyRuntime-dev`** with both event triggers **disabled** (64 resources): HTTP API with a Cognito JWT authorizer on 17 routes (listed in section 5), `$default` stage throttled to 10 requests/second (burst 20), access logs with route templates only; three Lambda functions (API 512 MB/15 s, Device 512 MB/30 s, Dispatcher 512 MB/300 s) with 30-day log groups; one SQS recovery queue (SQS-managed encryption, 14 days); the device IoT policy (not attached to anything); the IoT topic rule (disabled); the outbox stream event source mapping (disabled); four CloudWatch alarms without actions.
4. **Enable the outbox dispatcher** (redeploy with `-c clippy:dispatcherEnabled=true`). See section 7.
5. **Enable the device request rule** (redeploy with `-c clippy:deviceRuleEnabled=true`). See section 7. Useful only with a provisioned test certificate (step 6).
6. **Create synthetic test identities**: two admin-created Cognito users with synthetic emails; one IoT thing named `dev_sample_001` with a test certificate attached to the `clippy-dev-device` policy, and a matching `devices` table identity record for the synthetic owner. Private key material stays on the test machine and never enters Git.

Commands (for the approved operator; not run by this work):

```sh
cd infra
npx cdk diff --all
npx cdk deploy ClippyData-dev
npx cdk deploy ClippyRuntime-dev
npx cdk deploy ClippyRuntime-dev -c clippy:dispatcherEnabled=true   # step 4 only after approval
```

## 4. Local evidence and its limits

Local checks at the candidate: `npm run check` (contracts in three languages, 52 backend tests plus 1 skipped placeholder, lint, format, Swift, synth with 25 template assertions) and `npm run test:dynamodb` (9 adapter tests, 41 engine tests on DynamoDB Local 3.3.2, bundled API Lambda smoke test). See [P04 handoff](../handoffs/P04-backend.md).

These do **not** prove: Cognito-issued JWT claims and the authorizer's audience behavior, S3 presigned PUT signing with `If-None-Match`, the bucket policy denial, KMS permissions, IoT policy variables and rule SQL, real DynamoDB transaction and GSI timing, stream filter behavior, or the IoT data endpoint. They are the live checks in section 6.

## 5. IAM and access summary

- **API function**: item-level DynamoDB actions (`GetItem`, `BatchGetItem`, `Query`, `PutItem`, `DeleteItem`, `BatchWriteItem`, `ConditionCheckItem`) on the four tables and their indexes; `kms:Decrypt/Encrypt/GenerateDataKey` on the data key; `s3:GetObject` on `u/*` (to sign 60-second read URLs).
- **Device function**: same table and key access; `s3:PutObject` and `s3:GetObject` on `u/*` (to sign 15-minute immutable PUTs and read manifests); `iot:Publish` on `clippy/v1/devices/*/responses/*`; `iot:DescribeEndpoint` (`*`, no resource-level support); SQS send to the recovery queue (async failure destination).
- **Dispatcher function**: same table and key access; `s3:GetObject` and `s3:DeleteObject` on `u/*`; `s3:ListBucket` limited to prefix `u/*`; stream read on the operations stream; `dynamodb:ListStreams` (`*`, no resource-level support); SQS send to the recovery queue.
- **IoT rule error role**: SQS send to the recovery queue, trusted only by `iot.amazonaws.com` from this account.
- **Device policy**: connect only as the attached thing's own name; publish to its own `requests` and `acknowledgements`; subscribe and receive only its own `responses/*` and `commands`.
- No `s3:*`, `dynamodb:*`, `dynamodb:Scan`, bucket administration, wildcard actions, schedules or reserved concurrency. Template assertions fail synthesis if any appear.

Routes (all require a Cognito access token with scope `clippy/journal`): `GET /v1/me`, `PATCH /v1/me/preferences`, `DELETE /v1/me`, `GET /v1/devices`, `GET /v1/devices/{deviceId}`, `POST /v1/devices/{deviceId}/sync-requests`, `GET /v1/sync-requests/{syncRequestId}`, `POST /v1/sync-requests/{syncRequestId}/cancel`, `GET /v1/days`, `GET /v1/days/{dayId}`, `DELETE /v1/days/{dayId}`, `GET /v1/days/{dayId}/moments`, `PUT /v1/days/{dayId}/reflections/{reflectionId}`, `PUT /v1/moments/{momentId}/corrections/{correctionId}`, `POST /v1/captures/{captureId}/read-url`, `DELETE /v1/captures/{captureId}`, `GET /v1/deletion-jobs/{jobId}`. Device routes are not exposed through API Gateway; devices use MQTT.

## 6. Bounded live test plan (synthetic data only, after approval)

1. Sign in user A through the hosted UI (PKCE). `GET /v1/me` with the access token returns 200. The same call with the ID token returns 401. A token without scope `clippy/journal` is rejected by the authorizer.
2. User B receives 404 for user A's device, sync request, day, capture read URL and deletion job.
3. Through MQTT as `dev_sample_001`: `sync.begin`, `upload.grants` for one fixture PNG, PUT with exactly the returned headers succeeds; repeating the PUT returns 412; a PUT without `If-None-Match` or with a different `Content-Type` is rejected; `sync.complete` returns a receipt; publishing to another thing's topic is denied by the policy.
4. With the dispatcher enabled: the day becomes `pending` within a minute; disabling the mapping, completing another snapshot, then running `npx tsx services/backend/src/tools/recover.ts --limit 5` dispatches the pending entry exactly once.
5. Delete the capture, then the day, then user B's account; confirm objects are gone under `u/OWNER/`, the deletion job reaches `waiting_for_clients`, and receipts no longer contain edit text.
6. Record request IDs and outcomes only. Stop after the plan; no load testing.

Stopping rule: if more than about 20% of these steps fail, stop and diagnose before retrying.

## 7. Event-driven components (not scheduled; each needs explicit activation approval)

- **Outbox dispatcher** (DynamoDB stream to Lambda). Runs when a new outbox item is inserted (snapshot accepted, day revision changed, deletion requested). Modifies journal items, deletes S3 objects for deletions, and (after P08) starts Step Functions executions. Batch size 10, three retries with bisecting, failed batches recorded in the recovery queue (metadata only). **Stop:** redeploy without the flag, or `aws lambda update-event-source-mapping --uuid UUID --no-enabled`. Pending work stays in the `pending` index for the manual recovery command.
- **Device request rule** (IoT topic rule to Lambda). Runs when a device publishes to `clippy/v1/devices/THING/requests`. Writes sync, snapshot, grant and receipt records and signs upload URLs. **Stop:** redeploy without the flag, or `aws iot disable-topic-rule --rule-name NAME`.
- **No schedules.** There is no EventBridge rule or Scheduler schedule, no retention expiry, and no cloud reconciliation job. The recovery command runs only when an operator invokes it.

## 8. Cost estimate (list prices to re-check at deployment; not verified against a live price list)

Idle, per month: KMS key about USD 1.00; four alarms about USD 0.40; DynamoDB on demand, S3, Lambda, API Gateway, IoT Core, SQS and CloudWatch Logs at synthetic test volume are well under USD 1.00 combined; Cognito Essentials is within its free monthly active user tier for two test users; CDK bootstrap storage is negligible. **Expected: about USD 2 per month idle, under USD 1 for the bounded live test.** No Bedrock or other model spend is part of P04.

## 9. Data, retention and deletion

Only synthetic users, fixture images from `fixtures/media/`, and synthetic text. DynamoDB TTL removes expired idempotency receipts, cursors and dispatched outbox entries eventually; it is not a deletion guarantee. Point-in-time recovery and S3 versioning are off, so explicit deletion removes the only copy; enabling either later needs a deletion-ledger replay procedure first. Raw-image expiry (proposed seven days) is not configured; it requires the retention decision and its own approval.

## 10. Rollback

- Runtime: `npx cdk destroy ClippyRuntime-dev` removes the API, functions, rule, policy, queue and alarms. It does not touch data.
- Data stack resources are retained by design. Full teardown of the development environment is manual and destructive: delete the synthetic users and pool (disable deletion protection first), empty and delete the bucket, disable deletion protection and delete the four tables, and schedule the KMS key for deletion (7 to 30 day waiting period). Each step needs its own confirmation.
- Bootstrap: delete the `CDKToolkit` stack only if no other CDK app uses the account and region.

## 11. Deployment record (2026-11-07)

- Approved by Josue for steps 1 to 3 only (bootstrap, Data, Runtime), with mock models and both event triggers disabled. Steps 4 to 6 (dispatcher activation, device rule activation, synthetic identities and certificates) and the paid model evaluation remain unapproved.
- Environment: the team SSO account (`ClippyHackers` permission set), us-east-1. Account ID, endpoint and pool identifiers are not recorded in Git.
- Source: `p08-processing` at `83f8dcf`. This includes P04 and P08 plus two pre-deployment fixes found by a CDK CLI synth: the app now honors `CDK_OUTDIR`, and strong cross-stack references are set explicitly.
- Results:
  1. `cdk bootstrap` created the `CDKToolkit` stack. Note: CDK's default bootstrap gives the CloudFormation execution role `AdministratorAccess`; narrow it with `--cloudformation-execution-policies` if the team account requires.
  2. `ClippyData-dev`: `CREATE_COMPLETE`, 12 resources.
  3. `ClippyRuntime-dev`: `CREATE_COMPLETE`, 73 resources. Josue ran it, because Claude Code's permission policy blocks IAM-creating deploys from the agent. The team permission set allowed IAM, KMS, Cognito, IoT, Step Functions and Lambda creation.
- Live checks (read-only, no credentials used against the API):
  - Outbox event source mapping state is `Disabled`, with its outbox filter attached.
  - The IoT device request rule is disabled.
  - The recap state machine exists and is idle.
  - App routes (`/v1/me`, `/v1/days`, `/v1/devices`) return 401 without a token and with a malformed token, consistently after the stage finished propagating. For about a minute after creation some requests returned 404.
  - Device, local and later-phase routes (`/v1/device/snapshots`, `/local/*`, `/v1/calendar/snapshots`) return 404 because they are not exposed.
- Not yet verified live: a real Cognito access token (needs a synthetic user), S3 presigned PUT and the bucket-policy denial, the IoT policy and rule SQL (needs a test certificate), real transactions and stream filtering (needs the dispatcher), and Bedrock through the Mantle endpoint.
- Running cost: about USD 2 per month idle (KMS key plus alarms). Rollback is as in section 10.
