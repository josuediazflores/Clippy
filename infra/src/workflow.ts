import path from "node:path";
import {
  Aws,
  Duration,
  RemovalPolicy,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
  aws_logs as logs,
  aws_stepfunctions as sfn,
  aws_stepfunctions_tasks as tasks,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { POLICY, type RetryRule } from "../../services/processing/src/policy";
import {
  pipelineVersion,
  type PipelineConfig,
} from "../../services/processing/src/config";

const ROOT = path.resolve(__dirname, "../..");

export interface RecapWorkflowProps {
  config: PipelineConfig;
  environment: Record<string, string>;
  /** Grants the task function table, key and media-read access. */
  grant: (fn: lambda.IFunction) => void;
}

/**
 * Standard workflow: Begin -> Map(Observe, bounded) -> Synthesize -> Publish, with failures
 * recorded by MarkFailed. Every state passes IDs, status words and counts only; photo text
 * and recap content live in DynamoDB, never in execution history.
 */
export class RecapWorkflow extends Construct {
  readonly stateMachine: sfn.StateMachine;
  readonly fn: nodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: RecapWorkflowProps) {
    super(scope, id);
    const { config } = props;
    const logGroup = new logs.LogGroup(this, "TaskLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.fn = new nodejs.NodejsFunction(this, "TaskFunction", {
      entry: path.join(ROOT, "services/processing/src/lambda/tasks.ts"),
      handler: "handler",
      projectRoot: ROOT,
      depsLockFilePath: path.join(ROOT, "package-lock.json"),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024,
      // Longest model timeout plus storage work.
      timeout: Duration.seconds(
        Math.ceil(
          Math.max(config.observation.timeoutMs, config.synthesis.timeoutMs) /
            1000,
        ) + 60,
      ),
      environment: {
        ...props.environment,
        CLIPPY_PIPELINE_CONFIG: JSON.stringify(config),
      },
      logGroup,
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node22",
        format: nodejs.OutputFormat.CJS,
        externalModules: [],
      },
    });
    props.grant(this.fn);
    if (config.provider === "bedrock")
      this.fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["bedrock-mantle:CreateInference"],
          resources: [
            `arn:${Aws.PARTITION}:bedrock-mantle:${Aws.REGION}:${Aws.ACCOUNT_ID}:project/*`,
          ],
        }),
      );

    const ref = {
      owner: sfn.JsonPath.stringAt("$.owner"),
      dayId: sfn.JsonPath.stringAt("$.dayId"),
      jobId: sfn.JsonPath.stringAt("$.jobId"),
      inputRevision: sfn.JsonPath.numberAt("$.inputRevision"),
    };
    const retry = (state: tasks.LambdaInvoke, rules: readonly RetryRule[]) => {
      for (const rule of rules)
        state.addRetry({
          errors: [...rule.errors],
          interval: Duration.seconds(rule.intervalSeconds),
          maxAttempts: rule.maxAttempts,
          backoffRate: rule.backoffRate,
          maxDelay: Duration.seconds(rule.maxDelaySeconds),
          jitterStrategy: sfn.JitterType.FULL,
        });
      return state;
    };
    const invoke = (
      name: string,
      payload: Record<string, unknown>,
      resultPath: string,
    ) =>
      new tasks.LambdaInvoke(this, name, {
        lambdaFunction: this.fn,
        payload: sfn.TaskInput.fromObject(payload),
        payloadResponseOnly: true,
        retryOnServiceExceptions: false,
        resultPath,
      });

    const markFailed = invoke(
      "MarkFailed",
      { ...ref, action: "fail", error: sfn.JsonPath.stringAt("$.error.Error") },
      "$.failure",
    );
    retry(markFailed, POLICY.step);
    // No Cause: error messages are not copied into history.
    markFailed.next(
      new sfn.Fail(this, "JobFailed", { error: "RecapJobFailed" }),
    );

    const begin = retry(
      invoke("Begin", { ...ref, action: "begin" }, "$.begin"),
      POLICY.step,
    );
    begin.addCatch(markFailed, {
      errors: ["States.ALL"],
      resultPath: "$.error",
    });

    const observe = retry(
      invoke(
        "Observe",
        {
          ...ref,
          action: "observe",
          captureId: sfn.JsonPath.stringAt("$.captureId"),
        },
        "$",
      ),
      POLICY.observe,
    );
    observe.addCatch(
      new sfn.Pass(this, "ObservationFailed", {
        parameters: {
          "captureId.$": "$.captureId",
          status: "failed",
          "reason.$": "$.error.Error",
          calls: 0,
          usage: { inputTokens: 0, outputTokens: 0 },
        },
      }),
      { errors: ["States.ALL"], resultPath: "$.error" },
    );
    const map = new sfn.Map(this, "ObserveCaptures", {
      itemsPath: "$.begin.captureIds",
      maxConcurrency: config.concurrency,
      itemSelector: {
        "owner.$": "$.owner",
        "dayId.$": "$.dayId",
        "jobId.$": "$.jobId",
        "inputRevision.$": "$.inputRevision",
        "captureId.$": "$$.Map.Item.Value",
      },
      resultPath: "$.observations",
    });
    map.itemProcessor(observe);

    const synthesize = retry(
      invoke(
        "Synthesize",
        {
          ...ref,
          action: "synthesize",
          observations: sfn.JsonPath.listAt("$.observations"),
        },
        "$.synthesis",
      ),
      POLICY.synthesize,
    );
    synthesize.addCatch(markFailed, {
      errors: ["States.ALL"],
      resultPath: "$.error",
    });
    const publish = retry(
      invoke("Publish", { ...ref, action: "publish" }, "$.publish"),
      POLICY.step,
    );
    publish.addCatch(markFailed, {
      errors: ["States.ALL"],
      resultPath: "$.error",
    });
    publish.next(new sfn.Succeed(this, "Done"));

    const definition = begin.next(
      new sfn.Choice(this, "NeedsWork")
        .when(
          sfn.Condition.stringEquals("$.begin.status", "observing"),
          map.next(synthesize).next(
            new sfn.Choice(this, "Publishable")
              .when(
                sfn.Condition.stringEquals("$.synthesis.status", "candidate"),
                publish,
              )
              .when(
                sfn.Condition.stringEquals("$.synthesis.status", "failed"),
                new sfn.Fail(this, "StoppedBeforePublication", {
                  error: "RecapNotPublished",
                }),
              )
              .otherwise(new sfn.Succeed(this, "SupersededDuringWork")),
          ),
        )
        .otherwise(new sfn.Succeed(this, "NothingToDo")),
    );

    this.stateMachine = new sfn.StateMachine(this, "StateMachine", {
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: Duration.hours(1),
      comment: `Clippy recap workflow, pipeline ${pipelineVersion(config)}`,
      logs: {
        destination: new logs.LogGroup(this, "WorkflowLogs", {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
        level: sfn.LogLevel.ERROR,
        includeExecutionData: false,
      },
      tracingEnabled: false,
    });
  }
}
