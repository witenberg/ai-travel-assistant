import {
  Stack, type StackProps, RemovalPolicy, CfnOutput, SecretValue, Duration,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');

/** Inference profile id — modern Anthropic models are only reachable this way. */
const MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

/** OAuth scopes, one per tool. The Gateway will enforce these; `guard.ts` mirrors them locally. */
const TOOL_SCOPES = ['places:read', 'weather:read', 'photos:search', 'flights:read'] as const;

/**
 * One stack, one `cdk destroy`. The app is small and the 10 USD budget makes a single
 * teardown command worth more than fine-grained stack boundaries.
 *
 * Every stateful resource carries RemovalPolicy.DESTROY on purpose: nothing here is
 * production data, and a stack that refuses to delete is a budget leak.
 */
export class TravelAssistantStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    // ---------------------------------------------------------------- identity (inbound)
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'travel-assistant',
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const userPoolDomain = userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: `travel-assistant-${this.account}` },
    });

    // A resource server turns our tool scopes into real OAuth scopes the Gateway can check.
    const resourceServer = userPool.addResourceServer('ToolScopes', {
      identifier: 'tools',
      scopes: TOOL_SCOPES.map(
        (s) => new cognito.ResourceServerScope({ scopeName: s, scopeDescription: `Allows ${s}` }),
      ),
    });

    // Machine-to-machine client: the BFF gets a token without a human in the loop.
    const machineClient = userPool.addClient('MachineClient', {
      generateSecret: true,
      authFlows: { userPassword: false },
      oAuth: {
        flows: { clientCredentials: true },
        scopes: TOOL_SCOPES.map((s) =>
          cognito.OAuthScope.resourceServer(resourceServer, new cognito.ResourceServerScope({
            scopeName: s, scopeDescription: `Allows ${s}`,
          })),
        ),
      },
    });

    // ---------------------------------------------------------------- application data
    const table = new ddb.Table(this, 'AppData', {
      partitionKey: { name: 'pk', type: ddb.AttributeType.STRING },
      sortKey: { name: 'sk', type: ddb.AttributeType.STRING },
      // On-demand: no idle cost, which is the only acceptable mode on this budget.
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // ---------------------------------------------------------------- identity (outbound)
    // ADR-0002: Secrets Manager holds the token, AgentCore Identity serves it to the
    // workload. The placeholder is overwritten manually — a real secret never enters
    // the template, because CloudFormation templates are readable by anyone with
    // stack read access and are stored unencrypted in the CDK staging bucket.
    const duffelSecret = new secrets.Secret(this, 'DuffelToken', {
      description: 'Duffel API access token (set manually after deploy)',
      secretObjectValue: { token: SecretValue.unsafePlainText('REPLACE_ME') },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const duffelCredentials = new agentcore.CfnApiKeyCredentialProvider(this, 'DuffelCredentials', {
      name: 'duffel-api-key',
      apiKeySecretSource: 'EXTERNAL',
      apiKeySecretConfig: { secretId: duffelSecret.secretArn, jsonKey: 'token' },
    });

    // ---------------------------------------------------------------- agent memory
    const memory = new agentcore.CfnMemory(this, 'Memory', {
      name: 'travel_assistant_memory',
      description: 'Short-term conversation state for the travel assistant',
      // Shortest useful retention. Memory is billed on stored events, so a long
      // expiry on a playground account is money spent on nothing.
      eventExpiryDuration: 7,
    });

    // ---------------------------------------------------------------- container image
    const image = new ecrAssets.DockerImageAsset(this, 'AgentImage', {
      directory: REPO_ROOT,
      // AgentCore Runtime only accepts ARM64.
      platform: ecrAssets.Platform.LINUX_ARM64,
    });

    // ---------------------------------------------------------------- runtime role
    const runtimeRole = new iam.Role(this, 'RuntimeRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': `arn:aws:bedrock-agentcore:${this.region}:${this.account}:*` },
        },
      }),
      description: 'Execution role for the travel assistant AgentCore Runtime',
    });

    // The agent calls exactly one model. Scoping to the inference profile plus the
    // underlying foundation models keeps this from becoming bedrock:* by habit.
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${MODEL_ID}`,
        `arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-*`,
      ],
    }));

    // Outbound credentials via the AgentCore token vault (ADR-0002).
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:GetWorkloadAccessToken', 'bedrock-agentcore:GetResourceApiKey'],
      resources: ['*'],
    }));

    table.grantReadWriteData(runtimeRole);
    image.repository.grantPull(runtimeRole);

    // CreateLogGroup matters: AgentCore creates the runtime's log group itself, and
    // without this permission it silently cannot — the first deploy produced a runtime
    // that ran fine and logged nowhere.
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'logs:CreateLogGroup', 'logs:CreateLogStream',
        'logs:PutLogEvents', 'logs:DescribeLogStreams', 'logs:DescribeLogGroups',
      ],
      resources: [
        `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/*`,
        `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/*:log-stream:*`,
      ],
    }));

    // ---------------------------------------------------------------- runtime
    const runtime = new agentcore.CfnRuntime(this, 'Runtime', {
      agentRuntimeName: 'travel_assistant',
      description: 'AI travel assistant',
      roleArn: runtimeRole.roleArn,
      agentRuntimeArtifact: { containerConfiguration: { containerUri: image.imageUri } },
      // PUBLIC avoids a VPC, and a VPC here would mean NAT Gateway — the single most
      // expensive thing we could accidentally leave running.
      networkConfiguration: { networkMode: 'PUBLIC' },
      protocolConfiguration: 'HTTP',
      environmentVariables: {
        MODEL_ID,
        TABLE_NAME: table.tableName,
        MEMORY_ID: memory.attrMemoryId,
        DUFFEL_CREDENTIAL_PROVIDER: duffelCredentials.name,
        NODE_ENV: 'production',
      },
    });
    runtime.addResourceDependency(memory);
    runtime.addResourceDependency(duffelCredentials);

    // AgentCore writes to /aws/bedrock-agentcore/runtimes/<agentRuntimeId>-<endpointName>.
    // We declare it ourselves rather than let AgentCore auto-create it, for two reasons:
    // an auto-created group never expires, and it would survive `cdk destroy`.
    // The name depends on the runtime id, so this resource is created after the runtime.
    new logs.LogGroup(this, 'AgentLogs', {
      logGroupName: `/aws/bedrock-agentcore/runtimes/${runtime.attrAgentRuntimeId}-DEFAULT`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // ---------------------------------------------------------------- entry layer
    // ADR-0001: the request path is Cognito -> API Gateway -> Lambda BFF -> Runtime.
    // The BFF exists for one reason: it turns a verified `sub` into a session id, and a
    // session id the client can choose is a way into another user's Memory.
    const bffLogs = new logs.LogGroup(this, 'BffLogs', {
      logGroupName: '/aws/lambda/travel-assistant-bff',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const bff = new lambdaNode.NodejsFunction(this, 'Bff', {
      functionName: 'travel-assistant-bff',
      entry: path.join(REPO_ROOT, 'src/bff/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      // ARM64 is ~20% cheaper per GB-second and this code has no native dependencies.
      architecture: lambda.Architecture.ARM_64,
      // The function spends nearly all of its life waiting on a socket, and that wait is
      // billed in GB-seconds — so memory size multiplies the cost of doing nothing.
      // 256 MB is ample for JSON parsing and a single SDK call.
      memorySize: 256,
      // One second under the API Gateway integration ceiling, so the Lambda times out
      // first and writes a span. If the gateway gave up first we would get a bare 504
      // and no record of how far the turn got.
      timeout: Duration.seconds(28),
      logGroup: bffLogs,
      environment: {
        AGENT_RUNTIME_ARN: runtime.attrAgentRuntimeArn,
        AGENT_ENDPOINT_NAME: 'DEFAULT',
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: {
        // CJS, not ESM, and this cost a deploy. AWS SDK v3 is CJS internally; bundled
        // into an ESM output it reaches `require("node:https")` at load time, which an
        // ES module cannot do — the function died in INIT with
        // `Dynamic require of "node:https" is not supported` and API Gateway reported a
        // bare 502. The usual workaround is a `createRequire` banner, but that smuggles
        // `require` back into an ES module to paper over the mismatch. Our source stays
        // ESM; only the bundle esbuild emits is CJS, and nothing here needs top-level await.
        format: lambdaNode.OutputFormat.CJS,
        target: 'node22',
        sourceMap: true,
        // Nothing is left external. The Node 22 runtime ships *some* of AWS SDK v3, but
        // which clients and at which version is not a contract we control — and
        // `client-bedrock-agentcore` is new enough that relying on it being present is a
        // bet. Bundling costs a couple of megabytes and removes the class of failure
        // that only shows up in the cloud.
        externalModules: [],
      },
      projectRoot: REPO_ROOT,
      depsLockFilePath: path.join(REPO_ROOT, 'package-lock.json'),
      description: 'Maps an authenticated user to an AgentCore session and invokes the Runtime',
    });

    // Scoped to this runtime and its endpoints. `InvokeAgentRuntime` on "*" would let the
    // BFF call any agent in the account, which is exactly the blast radius we can avoid
    // for free here.
    bff.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:InvokeAgentRuntime'],
      resources: [
        runtime.attrAgentRuntimeArn,
        `${runtime.attrAgentRuntimeArn}/runtime-endpoint/*`,
      ],
    }));

    const api = new apigw.RestApi(this, 'Api', {
      restApiName: 'travel-assistant',
      description: 'Public entry point for the travel assistant',
      deployOptions: {
        stageName: 'v1',
        // Stage-level throttling is the budget brake that does not depend on a key:
        // it applies to every caller, including one holding a valid token.
        throttlingRateLimit: 2,
        throttlingBurstLimit: 5,
        // Detailed per-method metrics and access logs are deliberately off. Both are
        // billable, and account-level API Gateway logging needs an `AWS::ApiGateway::Account`
        // role that would outlive `cdk destroy`.
      },
      // No account-level CloudWatch role. CDK creates one by default, but it writes to
      // `AWS::ApiGateway::Account`, which is a single account-wide setting shared with
      // every other API in the account — `cdk destroy` would then either leave it behind
      // or reset something we do not own. We do not use access logging, so we opt out.
      cloudWatchRole: false,
      // REST, not HTTP API: the Cognito authorizer, usage plans and API keys we rely on
      // here are REST features. HTTP API is cheaper but has neither usage plans nor keys.
      endpointTypes: [apigw.EndpointType.REGIONAL],
    });

    const authorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'JwtAuthorizer', {
      cognitoUserPools: [userPool],
      authorizerName: 'travel-assistant-jwt',
    });

    const chat = api.root.addResource('chat');
    chat.addMethod('POST', new apigw.LambdaIntegration(bff, { proxy: true }), {
      authorizer,
      authorizationType: apigw.AuthorizationType.COGNITO,
      // The gateway admits a token carrying any one of these; which tools it may then
      // use is decided per call, from the same claim, by the BFF and the guard.
      authorizationScopes: TOOL_SCOPES.map((s) => `${resourceServer.userPoolResourceServerId}/${s}`),
      // A key is required on top of the JWT purely so the request falls under a usage
      // plan — that is the only way to attach a daily quota in API Gateway.
      apiKeyRequired: true,
    });

    const apiKey = api.addApiKey('DefaultKey', { apiKeyName: 'travel-assistant-key' });
    const plan = api.addUsagePlan('DefaultPlan', {
      name: 'travel-assistant-plan',
      throttle: { rateLimit: 2, burstLimit: 5 },
      // The number that actually protects the 10 USD cap. One turn is roughly three
      // model calls, ~6k input and ~1k output tokens, which at Haiku 4.5 list rates is
      // about 1 US cent. 100 calls a day is therefore a ceiling near 1 USD a day —
      // a tenth of the account cap per day, which is the most we are willing to lose
      // to a runaway loop or a leaked key overnight.
      quota: { limit: 100, period: apigw.Period.DAY },
    });
    plan.addApiKey(apiKey);
    plan.addApiStage({ stage: api.deploymentStage });

    // ---------------------------------------------------------------- outputs
    new CfnOutput(this, 'RuntimeArn', { value: runtime.attrAgentRuntimeArn });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'MachineClientId', { value: machineClient.userPoolClientId });
    new CfnOutput(this, 'TokenEndpoint', { value: `${userPoolDomain.baseUrl()}/oauth2/token` });
    new CfnOutput(this, 'DuffelSecretArn', { value: duffelSecret.secretArn });
    new CfnOutput(this, 'TableName', { value: table.tableName });
    new CfnOutput(this, 'ApiUrl', { value: `${api.url}chat` });
    new CfnOutput(this, 'ApiKeyId', { value: apiKey.keyId });
  }
}
