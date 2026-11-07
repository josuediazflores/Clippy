import path from "node:path";
import {
  Aws,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_apigateway as apigateway,
  aws_apigatewayv2 as apigwv2,
  aws_apigatewayv2_authorizers as authorizers,
  aws_apigatewayv2_integrations as integrations,
  aws_cloudwatch as cloudwatch,
  aws_iam as iam,
  aws_iot as iot,
  aws_lambda as lambda,
  aws_lambda_destinations as destinations,
  aws_lambda_event_sources as sources,
  aws_lambda_nodejs as nodejs,
  aws_logs as logs,
  aws_sqs as sqs,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import openapi from "../../contracts/openapi.json";
import type { DataStack } from "./data-stack";
import { TABLES } from "../../services/backend/src/store/store";

export interface RuntimeStackProps extends StackProps {
  envName: string;
  data: DataStack;
  /** Event-driven activation is opt-in per deployment approval (AGENTS.md). */
  dispatcherEnabled: boolean;
  deviceRuleEnabled: boolean;
  recapStateMachineArn: string | null;
  apiRateLimit: number;
  apiBurstLimit: number;
}

const ROOT = path.resolve(__dirname, "../..");
const DEVICE_TOPIC = "clippy/v1/devices";

/** App routes implemented so far, taken from the frozen OpenAPI document. */
export function implementedAppRoutes(): Array<{
  method: string;
  path: string;
}> {
  const routes: Array<{ method: string; path: string }> = [];
  const paths = openapi.paths as Record<
    string,
    Record<string, { tags?: string[]; "x-implementation-phase"?: string }>
  >;
  for (const [route, operations] of Object.entries(paths))
    for (const [method, op] of Object.entries(operations))
      if (
        op.tags?.includes("app") &&
        ["P03", "P04"].includes(op["x-implementation-phase"] ?? "")
      )
        routes.push({ method: method.toUpperCase(), path: route });
  return routes;
}

export class RuntimeStack extends Stack {
  readonly api: apigwv2.HttpApi;
  readonly recovery: sqs.Queue;

  constructor(scope: Construct, id: string, props: RuntimeStackProps) {
    super(scope, id, props);
    const { data } = props;

    this.recovery = new sqs.Queue(this, "RecoveryQueue", {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });

    const environment: Record<string, string> = {
      CLIPPY_TABLE_ACCOUNTS: data.tables.accounts.tableName,
      CLIPPY_TABLE_DEVICES: data.tables.devices.tableName,
      CLIPPY_TABLE_JOURNAL: data.tables.journal.tableName,
      CLIPPY_TABLE_OPERATIONS: data.tables.operations.tableName,
      CLIPPY_MEDIA_BUCKET: data.media.bucketName,
      CLIPPY_RECAP_STATE_MACHINE_ARN: props.recapStateMachineArn ?? "",
      NODE_OPTIONS: "--enable-source-maps",
    };
    const fn = (
      name: string,
      entry: string,
      timeout: number,
      memory: number,
    ) => {
      const logGroup = new logs.LogGroup(this, `${name}Logs`, {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      return new nodejs.NodejsFunction(this, name, {
        entry: path.join(ROOT, "services/backend/src/lambda", entry),
        handler: "handler",
        projectRoot: ROOT,
        depsLockFilePath: path.join(ROOT, "package-lock.json"),
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: memory,
        timeout: Duration.seconds(timeout),
        environment,
        logGroup,
        bundling: {
          minify: true,
          sourceMap: true,
          target: "node22",
          format: nodejs.OutputFormat.CJS,
          // Bundle the pinned SDK instead of relying on the runtime's copy.
          externalModules: [],
        },
      });
    };
    const apiFn = fn("ApiFunction", "api.ts", 15, 512);
    const deviceFn = fn("DeviceFunction", "device.ts", 30, 512);
    const dispatcherFn = fn("DispatcherFunction", "dispatcher.ts", 300, 512);

    // Table access: item-level actions only, on the four tables and their indexes.
    const tableArns = TABLES.flatMap((t) => [
      data.tables[t].tableArn,
      `${data.tables[t].tableArn}/index/*`,
    ]);
    const itemActions = [
      "dynamodb:GetItem",
      "dynamodb:BatchGetItem",
      "dynamodb:Query",
      "dynamodb:PutItem",
      "dynamodb:DeleteItem",
      "dynamodb:BatchWriteItem",
      "dynamodb:ConditionCheckItem",
    ];
    const media = data.media.arnForObjects("u/*");
    const kmsUse = (...actions: string[]) =>
      new iam.PolicyStatement({ actions, resources: [data.key.keyArn] });
    for (const f of [apiFn, deviceFn, dispatcherFn]) {
      f.addToRolePolicy(
        new iam.PolicyStatement({ actions: itemActions, resources: tableArns }),
      );
      f.addToRolePolicy(
        kmsUse("kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"),
      );
    }
    // API: presigned 60-second reads only.
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [media],
      }),
    );
    // Device requests: presigned immutable PUTs, plus manifest reads and object checks.
    deviceFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject", "s3:GetObject"],
        resources: [media],
      }),
    );
    deviceFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iot:Publish"],
        resources: [
          `arn:${Aws.PARTITION}:iot:${Aws.REGION}:${Aws.ACCOUNT_ID}:topic/${DEVICE_TOPIC}/*/responses/*`,
        ],
      }),
    );
    deviceFn.addToRolePolicy(
      // DescribeEndpoint has no resource-level permission.
      new iam.PolicyStatement({
        actions: ["iot:DescribeEndpoint"],
        resources: ["*"],
      }),
    );
    // Dispatcher: verification reads and deletion of owner media.
    dispatcherFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:DeleteObject"],
        resources: [media],
      }),
    );
    dispatcherFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:ListBucket"],
        resources: [data.media.bucketArn],
        conditions: { StringLike: { "s3:prefix": ["u/*"] } },
      }),
    );
    if (props.recapStateMachineArn)
      dispatcherFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["states:StartExecution"],
          resources: [props.recapStateMachineArn],
        }),
      );

    // Outbox stream: only INSERTs of outbox items; disabled until activation is approved.
    dispatcherFn.addEventSource(
      new sources.DynamoEventSource(data.tables.operations, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        enabled: props.dispatcherEnabled,
        batchSize: 10,
        bisectBatchOnError: true,
        retryAttempts: 3,
        maxRecordAge: Duration.hours(24),
        reportBatchItemFailures: true,
        onFailure: new sources.SqsDlq(this.recovery),
        filters: [
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.isEqual("INSERT"),
            dynamodb: {
              NewImage: { kind: { S: lambda.FilterRule.isEqual("outbox") } },
            },
          }),
        ],
      }),
    );

    // HTTP API with Cognito JWT authorization on every route.
    const issuer = `https://cognito-idp.${Aws.REGION}.amazonaws.com/${data.userPool.userPoolId}`;
    const authorizer = new authorizers.HttpJwtAuthorizer("CognitoJwt", issuer, {
      jwtAudience: [data.appClient.userPoolClientId],
      identitySource: ["$request.header.Authorization"],
    });
    apiFn.addEnvironment(
      "CLIPPY_COGNITO_CLIENT_ID",
      data.appClient.userPoolClientId,
    );
    apiFn.addEnvironment("CLIPPY_REQUIRED_SCOPE", data.scope);
    const accessLogs = new logs.LogGroup(this, "ApiAccessLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.api = new apigwv2.HttpApi(this, "Api", {
      description: `Clippy ${props.envName} app API`,
      createDefaultStage: false,
    });
    new apigwv2.HttpStage(this, "DefaultStage", {
      httpApi: this.api,
      stageName: "$default",
      autoDeploy: true,
      throttle: {
        rateLimit: props.apiRateLimit,
        burstLimit: props.apiBurstLimit,
      },
      accessLogSettings: {
        destination: new apigwv2.LogGroupLogDestination(accessLogs),
        // Route template and status only: no path values, query strings, IPs or claims.
        format: apigateway.AccessLogFormat.custom(
          JSON.stringify({
            requestId: "$context.requestId",
            routeKey: "$context.routeKey",
            status: "$context.status",
            latency: "$context.integrationLatency",
            error: "$context.error.messageString",
            authorizerError: "$context.authorizer.error",
          }),
        ),
      },
    });
    const integration = new integrations.HttpLambdaIntegration(
      "ApiIntegration",
      apiFn,
    );
    for (const route of implementedAppRoutes())
      this.api.addRoutes({
        path: route.path,
        methods: [route.method as apigwv2.HttpMethod],
        integration,
        authorizer,
        authorizationScopes: [data.scope],
      });

    // Device identity and topic policy. Attached to per-device certificates in P07.
    new iot.CfnPolicy(this, "DevicePolicy", {
      policyName: `clippy-${props.envName}-device`,
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: "iot:Connect",
            Resource: `arn:${Aws.PARTITION}:iot:${Aws.REGION}:${Aws.ACCOUNT_ID}:client/\${iot:Connection.Thing.ThingName}`,
            Condition: { Bool: { "iot:Connection.Thing.IsAttached": "true" } },
          },
          {
            Effect: "Allow",
            Action: "iot:Publish",
            Resource: ["requests", "acknowledgements"].map(
              (leaf) =>
                `arn:${Aws.PARTITION}:iot:${Aws.REGION}:${Aws.ACCOUNT_ID}:topic/${DEVICE_TOPIC}/\${iot:Connection.Thing.ThingName}/${leaf}`,
            ),
          },
          {
            Effect: "Allow",
            Action: "iot:Subscribe",
            Resource: ["responses/*", "commands"].map(
              (leaf) =>
                `arn:${Aws.PARTITION}:iot:${Aws.REGION}:${Aws.ACCOUNT_ID}:topicfilter/${DEVICE_TOPIC}/\${iot:Connection.Thing.ThingName}/${leaf}`,
            ),
          },
          {
            Effect: "Allow",
            Action: "iot:Receive",
            Resource: ["responses/*", "commands"].map(
              (leaf) =>
                `arn:${Aws.PARTITION}:iot:${Aws.REGION}:${Aws.ACCOUNT_ID}:topic/${DEVICE_TOPIC}/\${iot:Connection.Thing.ThingName}/${leaf}`,
            ),
          },
        ],
      },
    });
    const ruleRole = new iam.Role(this, "DeviceRuleErrorRole", {
      assumedBy: new iam.ServicePrincipal("iot.amazonaws.com", {
        conditions: { StringEquals: { "aws:SourceAccount": Aws.ACCOUNT_ID } },
      }),
    });
    this.recovery.grantSendMessages(ruleRole);
    // Trusted identity comes from rule functions; payload fields are selected one by one.
    const rule = new iot.CfnTopicRule(this, "DeviceRequestRule", {
      topicRulePayload: {
        sql: `SELECT topic(4) AS thingName, clientid() AS clientId, principal() AS principal, schemaVersion, requestId, type, snapshotId, body FROM '${DEVICE_TOPIC}/+/requests'`,
        awsIotSqlVersion: "2016-03-23",
        ruleDisabled: !props.deviceRuleEnabled,
        actions: [{ lambda: { functionArn: deviceFn.functionArn } }],
        errorAction: {
          sqs: {
            queueUrl: this.recovery.queueUrl,
            roleArn: ruleRole.roleArn,
            useBase64: false,
          },
        },
      },
    });
    deviceFn.addPermission("IotRuleInvoke", {
      principal: new iam.ServicePrincipal("iot.amazonaws.com"),
      sourceArn: rule.attrArn,
      sourceAccount: Aws.ACCOUNT_ID,
    });
    new lambda.EventInvokeConfig(this, "DeviceAsyncConfig", {
      function: deviceFn,
      retryAttempts: 2,
      maxEventAge: Duration.minutes(15),
      onFailure: new destinations.SqsDestination(this.recovery),
    });

    // Alarms without actions: notification targets need an owner (deployment packet).
    new cloudwatch.Alarm(this, "RecoveryQueueNotEmpty", {
      metric: this.recovery.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5),
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    for (const [name, f] of [
      ["Api", apiFn],
      ["Device", deviceFn],
      ["Dispatcher", dispatcherFn],
    ] as const)
      new cloudwatch.Alarm(this, `${name}Errors`, {
        metric: f.metricErrors({ period: Duration.minutes(5) }),
        threshold: 0,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
  }
}
