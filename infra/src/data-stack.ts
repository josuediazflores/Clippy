import {
  Aws,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_cognito as cognito,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_kms as kms,
  aws_s3 as s3,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import { TABLE_DEFINITIONS } from "../../services/backend/src/store/schema";
import { TABLES, type Table } from "../../services/backend/src/store/store";

export interface DataStackProps extends StackProps {
  envName: string;
  callbackUrls: string[];
  logoutUrls: string[];
}

export const API_SCOPE_NAME = "journal";
export const RESOURCE_SERVER_ID = "clippy";

/**
 * Persistent resources. Everything here is retained when a stack is deleted; user data is
 * removed by the application deletion workflow, never by stack destruction.
 */
export class DataStack extends Stack {
  readonly key: kms.Key;
  readonly media: s3.Bucket;
  readonly tables: Record<Table, dynamodb.Table>;
  readonly userPool: cognito.UserPool;
  readonly appClient: cognito.UserPoolClient;
  readonly scope: string;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    this.key = new kms.Key(this, "DataKey", {
      description: `Clippy ${props.envName} media and table encryption`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
      alias: `alias/clippy-${props.envName}-data`,
    });

    // Raw media and manifests under u/<owner>/s/<snapshot>/<upload>. No public access,
    // no versioning (explicit deletion must remove bytes), no lifecycle expiry until the
    // retention policy is approved (D11).
    this.media = new s3.Bucket(this, "Media", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.key,
      bucketKeyEnabled: true,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      versioned: false,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // Uploads are immutable: any object creation without If-None-Match is denied.
    this.media.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "DenyUploadWithoutIfNoneMatch",
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["s3:PutObject"],
        resources: [this.media.arnForObjects("*")],
        conditions: {
          Null: { "s3:if-none-match": "true" },
          Bool: { "s3:ObjectCreationOperation": "true" },
        },
      }),
    );

    this.tables = {} as Record<Table, dynamodb.Table>;
    for (const name of TABLES) {
      const def = TABLE_DEFINITIONS[name];
      const table = new dynamodb.Table(
        this,
        `${name[0]!.toUpperCase()}${name.slice(1)}Table`,
        {
          partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
          sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
          billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
          encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
          encryptionKey: this.key,
          deletionProtection: true,
          removalPolicy: RemovalPolicy.RETAIN,
          // Backups would retain deleted user content; enable only with a deletion-ledger
          // replay procedure and an approved retention window (architecture section 11).
          pointInTimeRecoverySpecification: {
            pointInTimeRecoveryEnabled: false,
          },
          timeToLiveAttribute: def.ttl ?? undefined,
          stream: def.stream ? dynamodb.StreamViewType.NEW_IMAGE : undefined,
        },
      );
      for (const index of def.indexes)
        table.addGlobalSecondaryIndex({
          indexName: index.name,
          partitionKey: { name: index.pk, type: dynamodb.AttributeType.STRING },
          sortKey: { name: index.sk, type: dynamodb.AttributeType.STRING },
          projectionType: dynamodb.ProjectionType.ALL,
        });
      this.tables[name] = table;
    }

    // Identity is persistent: replacing the pool would change every owner subject.
    this.userPool = new cognito.UserPool(this, "Users", {
      // D49: hackathon users create their own accounts; email must be verified before sign-in.
      selfSignUpEnabled: true,
      autoVerify: { email: true },
      signInAliases: { email: true },
      signInCaseSensitive: false,
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const journal = new cognito.ResourceServerScope({
      scopeName: API_SCOPE_NAME,
      scopeDescription: "Read and write the signed-in user's journal",
    });
    const server = this.userPool.addResourceServer("Api", {
      identifier: RESOURCE_SERVER_ID,
      scopes: [journal],
    });
    this.scope = `${RESOURCE_SERVER_ID}/${API_SCOPE_NAME}`;
    // Public native client: authorization code with PKCE, no secret, no implicit flow.
    this.appClient = this.userPool.addClient("IosApp", {
      generateSecret: false,
      authFlows: {
        user: false,
        userPassword: false,
        userSrp: false,
        adminUserPassword: false,
        custom: false,
      },
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
          implicitCodeGrant: false,
          clientCredentials: false,
        },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.resourceServer(server, journal),
        ],
        callbackUrls: props.callbackUrls,
        logoutUrls: props.logoutUrls,
      },
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      accessTokenValidity: Duration.minutes(60),
      idTokenValidity: Duration.minutes(60),
      refreshTokenValidity: Duration.days(30),
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.COGNITO,
      ],
    });
    this.userPool.addDomain("HostedDomain", {
      cognitoDomain: {
        domainPrefix: `clippy-${props.envName}-${Aws.ACCOUNT_ID}`,
      },
    });
  }
}
