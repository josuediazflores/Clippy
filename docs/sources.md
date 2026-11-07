# Source notes

Official documentation consulted for the plan on 2026-11-07. Service capabilities, model availability, quotas, and prices must be rechecked when implementing/deploying. The repository's stack, workflow, interfaces, and phase structure are design recommendations, not claims that these sources prescribe one application architecture.

## Apple

- [EventKit event-store access](https://developer.apple.com/documentation/eventkit/accessing-the-event-store): reading calendar events requires full access; EventKit does not offer a read-only permission level. Clippy can still implement read-only behavior and selected-calendar filtering.
- [Background task earliestBeginDate](https://developer.apple.com/documentation/backgroundtasks/bgtaskrequest/earliestbegindate): earliest start is not an exact execution guarantee. The device upload schedule must not depend on an exact iPhone background wake.
- [Choosing background strategies](https://developer.apple.com/documentation/backgroundtasks/choosing-background-strategies-for-your-app): iOS selects execution timing for refresh/processing work.
- [Mail app extensions](https://developer.apple.com/videos/play/wwdc2021/10168/): MailKit extends Mail on macOS; this is not an iPhone inbox access plan.
- [iCloud Mail settings](https://support.apple.com/en-us/102525): IMAP access and app-specific password configuration.
- [iCloud data access in supported third-party apps](https://support.apple.com/en-us/121539): Apple Account authorization for supported apps and app-specific password fallback. Clippy's eligibility/integration path remains to be verified.

## AWS device and upload path

- [IoT device provisioning](https://docs.aws.amazon.com/iot/latest/developerguide/provision-wo-cert.html): trusted-user fleet provisioning is an available future onboarding path. Prototype per-device identity and application ownership remain distinct.
- [IoT credentials provider](https://docs.aws.amazon.com/iot/latest/developerguide/authorizing-direct-aws.html): device certificates can obtain limited temporary AWS credentials. This is an alternative to per-object upload grants, not required for the first version.
- [S3 presigned uploads](https://docs.aws.amazon.com/AmazonS3/latest/userguide/PresignedUrlUploadObject.html): upload grants target specific object keys.
- [S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html): If-None-Match prevents overwriting an existing key, and policies can enforce conditional requests. Integration must verify the exact signing/header path.
- [EventBridge Scheduler](https://docs.aws.amazon.com/scheduler/latest/UserGuide/what-is-scheduler.html): schedules invoke target APIs; this does not guarantee offline-device connectivity.
- [Scheduler timezones/DST](https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html): cloud Scheduler has its own DST rules. The device's proposed next-eligible-time policy is explicit application behavior, not an assumption that all schedulers behave identically.

## AWS processing and persistence

- [Step Functions Bedrock integration](https://docs.aws.amazon.com/step-functions/latest/dg/connect-bedrock.html): managed workflow integration is available; model adapters may still use Lambda for validation and provider normalization.
- [Step Functions error handling](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html): retries/catch behavior must be configured. Application side effects remain idempotent even when orchestration manages execution state.
- [Bedrock supported models](https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html): verify modality, model IDs, and regional availability before selecting a deployment configuration.
- [DynamoDB optimistic locking](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/BestPractices_OptimisticLocking.html): conditional version checks support conflict detection. Clippy's input/recap revision design builds on this primitive.
- [DynamoDB TTL](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html): expiry cleanup is asynchronous, typically within days, and is unsuitable as the sole immediate-deletion mechanism.
- [CDK testing](https://docs.aws.amazon.com/cdk/v2/guide/testing.html): synthesized-template assertions support local infrastructure verification but do not replace live authorization tests.
- [Amazon Location reverse geocoding](https://docs.aws.amazon.com/location/latest/developerguide/reverse-geocode.html): converts supplied coordinates to address/place context; it does not create GPS measurements.
- [SNS Apple push authentication](https://docs.aws.amazon.com/sns/latest/dg/sns-apple-authentication-methods.html): SNS delivery to iPhone uses APNs configuration and credentials.
