import assert from "node:assert/strict";
import { Match, Template } from "aws-cdk-lib/assertions";
import type { DataStack } from "./data-stack";
import { implementedAppRoutes, type RuntimeStack } from "./runtime-stack";
import { POLICY } from "../../services/processing/src/policy";

type Resource = {
  Type: string;
  Properties?: Record<string, unknown>;
  DeletionPolicy?: string;
};

/** Joins a Fn::Join definition, replacing deploy-time tokens with a placeholder string. */
function renderDefinition(value: unknown): Record<string, unknown> {
  const join = (value as { "Fn::Join": [string, unknown[]] })["Fn::Join"];
  const text = join[1]
    .map((part) => (typeof part === "string" ? part : "TOKEN"))
    .join(join[0]);
  return JSON.parse(text) as Record<string, unknown>;
}
function allStates(
  definition: Record<string, unknown>,
): Record<string, unknown> {
  const found: Record<string, unknown> = {};
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const states = (node as { States?: Record<string, unknown> }).States;
    if (states)
      for (const [name, state] of Object.entries(states)) {
        found[name] = state;
        walk((state as { ItemProcessor?: unknown }).ItemProcessor);
        walk((state as { Iterator?: unknown }).Iterator);
      }
  };
  walk(definition);
  return found;
}
const pipelineConcurrency = (runtime: RuntimeStack) =>
  runtime.workflowConcurrency;

/** Focused safety assertions run on every synth. Failing any of them blocks deployment. */
export function assertTemplates(data: DataStack, runtime: RuntimeStack) {
  let checks = 0;
  const check = (fn: () => void) => {
    fn();
    checks++;
  };
  const d = Template.fromStack(data);
  const r = Template.fromStack(runtime);
  const dataResources = d.toJSON().Resources as Record<string, Resource>;
  const runtimeResources = r.toJSON().Resources as Record<string, Resource>;

  // Persistence is retained, encrypted, private.
  check(() => d.resourceCountIs("AWS::DynamoDB::Table", 4));
  check(() =>
    d.allResourcesProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      DeletionProtectionEnabled: true,
      SSESpecification: {
        SSEEnabled: true,
        SSEType: "KMS",
        KMSMasterKeyId: Match.anyValue(),
      },
    }),
  );
  check(() => {
    for (const res of Object.values(dataResources))
      if (
        [
          "AWS::DynamoDB::Table",
          "AWS::S3::Bucket",
          "AWS::KMS::Key",
          "AWS::Cognito::UserPool",
        ].includes(res.Type)
      )
        assert.equal(
          res.DeletionPolicy,
          "Retain",
          `${res.Type} must be retained`,
        );
  });
  check(() =>
    d.hasResourceProperties("AWS::DynamoDB::Table", {
      StreamSpecification: { StreamViewType: "NEW_IMAGE" },
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
      GlobalSecondaryIndexes: [Match.objectLike({ IndexName: "pending" })],
    }),
  );
  check(() =>
    d.hasResourceProperties("AWS::DynamoDB::Table", {
      GlobalSecondaryIndexes: [Match.objectLike({ IndexName: "gsi1" })],
    }),
  );
  check(() =>
    d.hasResourceProperties("AWS::KMS::Key", { EnableKeyRotation: true }),
  );
  check(() =>
    d.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          Match.objectLike({
            BucketKeyEnabled: true,
            ServerSideEncryptionByDefault: Match.objectLike({
              SSEAlgorithm: "aws:kms",
            }),
          }),
        ],
      },
      VersioningConfiguration: Match.absent(),
      LifecycleConfiguration: Match.absent(),
    }),
  );
  for (const statement of [
    {
      Effect: "Deny",
      Action: "s3:PutObject",
      Condition: {
        Null: { "s3:if-none-match": "true" },
        Bool: { "s3:ObjectCreationOperation": "true" },
      },
    },
    { Effect: "Deny", Condition: { Bool: { "aws:SecureTransport": "false" } } },
  ])
    check(() =>
      d.hasResourceProperties("AWS::S3::BucketPolicy", {
        PolicyDocument: {
          Statement: Match.arrayWith([Match.objectLike(statement)]),
        },
      }),
    );
  check(() =>
    d.hasResourceProperties("AWS::Cognito::UserPool", {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
      AutoVerifiedAttributes: ["email"],
      DeletionProtection: "ACTIVE",
    }),
  );
  check(() =>
    d.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      GenerateSecret: false,
      AllowedOAuthFlows: ["code"],
      AllowedOAuthFlowsUserPoolClient: true,
      EnableTokenRevocation: true,
      PreventUserExistenceErrors: "ENABLED",
      // Third scope is the resource-server reference, resolved at deploy time.
      AllowedOAuthScopes: [
        "openid",
        "email",
        Match.objectLike({ "Fn::Join": Match.anyValue() }),
      ],
      ExplicitAuthFlows: ["ALLOW_REFRESH_TOKEN_AUTH"],
    }),
  );

  // No schedules, no cloud-side recurring work.
  check(() => {
    for (const template of [d, r])
      for (const type of [
        "AWS::Events::Rule",
        "AWS::Scheduler::Schedule",
        "AWS::Pipes::Pipe",
      ])
        template.resourceCountIs(type, 0);
  });

  // Every implemented app route requires the Cognito JWT and journal scope; no device or local routes.
  const routes = Object.values(runtimeResources).filter(
    (x) => x.Type === "AWS::ApiGatewayV2::Route",
  );
  check(() => assert.equal(routes.length, implementedAppRoutes().length));
  check(() => {
    for (const route of routes) {
      const p = route.Properties!;
      assert.equal(p.AuthorizationType, "JWT", String(p.RouteKey));
      assert.deepEqual(p.AuthorizationScopes, ["clippy/journal"]);
      assert.ok(
        !/\/v1\/device\/|\/local\/|\$default/.test(String(p.RouteKey)),
        String(p.RouteKey),
      );
    }
  });
  check(() =>
    r.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
      AuthorizerType: "JWT",
      IdentitySource: ["$request.header.Authorization"],
      JwtConfiguration: {
        Audience: [Match.anyValue()],
        Issuer: Match.anyValue(),
      },
    }),
  );
  check(() =>
    r.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      StageName: "$default",
      DefaultRouteSettings: {
        ThrottlingRateLimit: 10,
        ThrottlingBurstLimit: 20,
      },
      AccessLogSettings: { Format: Match.stringLikeRegexp("routeKey") },
    }),
  );
  check(() => {
    const stage = Object.values(runtimeResources).find(
      (x) => x.Type === "AWS::ApiGatewayV2::Stage",
    )!;
    const format = String(
      (stage.Properties!.AccessLogSettings as { Format: string }).Format,
    );
    for (const banned of [
      "$context.path",
      "identity.sourceIp",
      "authorizer.claims",
      "$context.requestOverride",
    ])
      assert.ok(!format.includes(banned), banned);
  });

  // Functions: Node 22 on ARM, bounded timeouts, logs retained 30 days.
  check(() =>
    r.allResourcesProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
    }),
  );
  check(() =>
    r.allResourcesProperties("AWS::Logs::LogGroup", { RetentionInDays: 30 }),
  );
  check(() => {
    for (const res of Object.values(runtimeResources).filter(
      (x) => x.Type === "AWS::Lambda::Function",
    ))
      assert.equal(
        res.Properties!.ReservedConcurrentExecutions ?? null,
        null,
        "reserved concurrency needs account headroom",
      );
  });

  // IAM: no service wildcards, no admin actions, "*" resources only where AWS requires it.
  check(() => {
    for (const res of Object.values(runtimeResources).filter(
      (x) => x.Type === "AWS::IAM::Policy",
    )) {
      const statements = (
        res.Properties!.PolicyDocument as {
          Statement: Array<{ Action: string | string[]; Resource: unknown }>;
        }
      ).Statement;
      for (const s of statements) {
        const actions = ([] as string[]).concat(s.Action);
        for (const action of actions) {
          assert.ok(
            !/^[a-z0-9-]+:\*$/.test(action) && action !== "*",
            `wildcard action ${action}`,
          );
          assert.ok(
            !/^s3:(PutBucket|DeleteBucket|PutObjectAcl)/.test(action),
            `bucket admin ${action}`,
          );
        }
        if (s.Resource === "*")
          for (const action of actions)
            assert.ok(
              // Actions AWS does not scope to resources: endpoint discovery, stream listing,
              // and the CloudWatch vended-log delivery Step Functions logging requires.
              [
                "iot:DescribeEndpoint",
                "dynamodb:ListStreams",
                "logs:CreateLogDelivery",
                "logs:GetLogDelivery",
                "logs:UpdateLogDelivery",
                "logs:DeleteLogDelivery",
                "logs:ListLogDeliveries",
                "logs:PutResourcePolicy",
                "logs:DescribeResourcePolicies",
                "logs:DescribeLogGroups",
              ].includes(action),
              `unscoped ${action}`,
            );
      }
    }
  });
  check(() => {
    const text = JSON.stringify(r.toJSON());
    assert.ok(
      !text.includes("s3:*") &&
        !text.includes("dynamodb:*") &&
        !text.includes("dynamodb:Scan"),
    );
  });

  // Event-driven activation is explicit.
  const mapping = Object.values(runtimeResources).find(
    (x) => x.Type === "AWS::Lambda::EventSourceMapping",
  )!;
  check(() => {
    const p = mapping.Properties!;
    assert.deepEqual(p.FunctionResponseTypes, ["ReportBatchItemFailures"]);
    assert.equal(p.BisectBatchOnFunctionError, true);
    assert.equal(p.MaximumRetryAttempts, 3);
    assert.ok(JSON.stringify(p.FilterCriteria).includes("outbox"));
    assert.ok(JSON.stringify(p.FilterCriteria).includes("INSERT"));
    assert.ok(
      p.DestinationConfig,
      "failed batches need a recovery destination",
    );
  });
  const rule = Object.values(runtimeResources).find(
    (x) => x.Type === "AWS::IoT::TopicRule",
  )!;
  check(() => {
    const payload = rule.Properties!.TopicRulePayload as {
      Sql: string;
      ErrorAction: unknown;
    };
    assert.match(
      payload.Sql,
      /^SELECT topic\(4\) AS thingName, clientid\(\) AS clientId, principal\(\) AS principal, /,
    );
    assert.ok(
      !/SELECT \*/.test(payload.Sql),
      "payload fields must be selected explicitly",
    );
    assert.ok(payload.ErrorAction);
  });
  check(() => {
    const policy = Object.values(runtimeResources).find(
      (x) => x.Type === "AWS::IoT::Policy",
    )!;
    const text = JSON.stringify(policy.Properties);
    assert.ok(text.includes("${iot:Connection.Thing.ThingName}"));
    assert.ok(text.includes("iot:Connection.Thing.IsAttached"));
    assert.ok(!/"Resource":"\*"/.test(text));
  });
  // Recap workflow (P08): Standard, bounded fan-out, shared retry policy, no content in history.
  const machine = Object.values(runtimeResources).find(
    (x) => x.Type === "AWS::StepFunctions::StateMachine",
  )!;
  const definition = renderDefinition(machine.Properties!.DefinitionString);
  const states = allStates(definition);
  check(() => {
    assert.equal(machine.Properties!.StateMachineType, "STANDARD");
    const logging = machine.Properties!.LoggingConfiguration as {
      IncludeExecutionData: boolean;
      Level: string;
    };
    assert.equal(logging.IncludeExecutionData, false);
    assert.equal(logging.Level, "ERROR");
  });
  check(() => {
    const map = states.ObserveCaptures as { MaxConcurrency: number };
    assert.equal(
      map.MaxConcurrency,
      runtime.workflow.stateMachine && pipelineConcurrency(runtime),
    );
  });
  check(() => {
    for (const [name, rules] of [
      ["Observe", POLICY.observe],
      ["Synthesize", POLICY.synthesize],
      ["Begin", POLICY.step],
      ["Publish", POLICY.step],
      ["MarkFailed", POLICY.step],
    ] as const) {
      const retry = (states[name] as { Retry: Array<Record<string, unknown>> })
        .Retry;
      assert.deepEqual(
        retry.map((r) => [
          r.ErrorEquals,
          r.IntervalSeconds,
          r.MaxAttempts,
          r.BackoffRate,
          r.MaxDelaySeconds,
          r.JitterStrategy,
        ]),
        rules.map((r) => [
          r.errors,
          r.intervalSeconds,
          r.maxAttempts,
          r.backoffRate,
          r.maxDelaySeconds,
          "FULL",
        ]),
        name,
      );
    }
  });
  check(() => {
    const text = JSON.stringify(definition);
    assert.ok(
      !text.includes("Cause"),
      "error causes are not copied into state",
    );
    for (const state of Object.values(states) as Array<{
      Type: string;
      Parameters?: { Payload?: Record<string, unknown> };
    }>)
      if (state.Type === "Task")
        for (const key of Object.keys(state.Parameters?.Payload ?? {}))
          assert.ok(
            [
              "action",
              "owner.$",
              "dayId.$",
              "jobId.$",
              "inputRevision.$",
              "captureId.$",
              "observations.$",
              "error.$",
            ].includes(key),
            `payload field ${key}`,
          );
  });
  check(() => {
    const text = JSON.stringify(r.toJSON());
    const bedrock = text.includes("bedrock-mantle:CreateInference");
    assert.equal(
      bedrock,
      runtime.workflowProvider === "bedrock",
      "model permission only for a Bedrock pipeline",
    );
    assert.ok(!/"bedrock:\*"|"bedrock-mantle:\*"/.test(text));
    assert.equal(
      text.includes("geo-places:ReverseGeocode"),
      runtime.workflowPlaces === "amazon-location",
      "place lookups only when configured",
    );
    assert.ok(!text.includes("geo-places:*") && !text.includes('"geo:'));
  });
  return {
    checks,
    data: Object.keys(dataResources).length,
    runtime: Object.keys(runtimeResources).length,
    dispatcherEnabled: mapping.Properties!.Enabled === true,
    deviceRuleEnabled:
      (rule.Properties!.TopicRulePayload as { RuleDisabled: boolean })
        .RuleDisabled === false,
  };
}
