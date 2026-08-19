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
import { GATEWAY_TOOLS } from '../../src/tools/index.js';
import { TOOL_TARGET_NAME } from '../../src/gateway/naming.js';
import { toolDefinitions } from './tool-schema.js';

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
    // AgentCore runs the extraction strategy below on its own schedule, under this role
    // rather than the runtime's. Wider than the runtime's model policy on purpose: the
    // extraction model is chosen by the service, not by us, so pinning it to the one
    // inference profile we use would break the day AWS changes that choice — and it
    // would break silently, as a strategy that quietly stops producing records.
    const memoryRole = new iam.Role(this, 'MemoryRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': `arn:aws:bedrock-agentcore:${this.region}:${this.account}:*` },
        },
      }),
      description: 'Extraction role for AgentCore Memory long-term strategies',
    });
    memoryRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        'arn:aws:bedrock:*::foundation-model/*',
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*`,
      ],
    }));

    const memory = new agentcore.CfnMemory(this, 'Memory', {
      name: 'travel_assistant_memory',
      description: 'Conversation state and travel preferences for the travel assistant',
      // Shortest useful retention. Memory is billed on stored events, so a long
      // expiry on a playground account is money spent on nothing. This bounds the raw
      // events only — extracted preference records have their own lifetime, which is
      // the point of the split: the conversation is cheap to forget, the lesson is not.
      eventExpiryDuration: 7,
      memoryExecutionRoleArn: memoryRole.roleArn,
      // Long-term memory. USER_PREFERENCE rather than SEMANTIC or SUMMARY because the
      // useful thing to carry between conversations is what this traveller likes, not a
      // precis of what was said — a summary strategy would re-store the same forecasts
      // we can fetch for free, and pay a model to write them.
      memoryStrategies: [{
        userPreferenceMemoryStrategy: {
          name: 'travel_preferences',
          description: 'Destinations, climate and trip style this traveller prefers',
          // Keyed on the actor, not the session: preferences must outlive a conversation.
          // {actorId} is substituted by AgentCore; PREFERENCE_NAMESPACE in
          // src/memory/store.ts builds the same string for retrieval and must match.
          namespaces: ['/preferences/{actorId}'],
        },
      }],
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

    // Memory data plane. Scoped to this one memory resource: the runtime has no business
    // reading events from any other, and `*` here would make cross-actor recall a policy
    // change away rather than an impossibility.
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'bedrock-agentcore:CreateEvent',
        'bedrock-agentcore:ListEvents',
        'bedrock-agentcore:RetrieveMemoryRecords',
      ],
      resources: [
        `arn:aws:bedrock-agentcore:${this.region}:${this.account}:memory/${memory.attrMemoryId}`,
        `arn:aws:bedrock-agentcore:${this.region}:${this.account}:memory/${memory.attrMemoryId}/*`,
      ],
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

    // ---------------------------------------------------------------- gateway (managed MCP)
    /*
     * ADR-0004. The Gateway is the managed MCP server that serves our three keyless tools,
     * and the reason it is here is authorization rather than plumbing: it validates the
     * caller's Cognito token itself, and a REQUEST interceptor decides per tool call whether
     * the scopes in that token permit it. Before this, the same decision was made by our own
     * `guard.ts` inside the agent — which is to say, by the component being restricted.
     *
     * Two Lambdas support it. Both are deliberately small and both are on the critical path
     * of every tool call, so their timeouts matter more than their memory.
     */
    const gatewayRole = new iam.Role(this, 'GatewayRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': `arn:aws:bedrock-agentcore:${this.region}:${this.account}:*` },
        },
      }),
      description: 'Service role for the travel assistant AgentCore Gateway',
    });

    const interceptorLogs = new logs.LogGroup(this, 'InterceptorLogs', {
      logGroupName: '/aws/lambda/travel-assistant-gateway-interceptor',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    /*
     * The interceptor. This function's log group is where the diagram's denial trace lives:
     * `agent attempted get_weather -> interceptor caught it -> call was blocked`. It is a
     * separate group from the Runtime's, so the smoke test reads two groups to follow one
     * turn — the price of the decision being made outside our container, which is the point.
     */
    const interceptor = new lambdaNode.NodejsFunction(this, 'GatewayInterceptor', {
      functionName: 'travel-assistant-gateway-interceptor',
      entry: path.join(REPO_ROOT, 'src/gateway/interceptor.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      // It decodes a JWT and compares two short strings. 128 MB is the floor and ample.
      memorySize: 128,
      // Short on purpose: this runs before *every* tool call, so its timeout is added to
      // every tool call's latency in the worst case. A slow authorization decision is a
      // failed one as far as the turn is concerned.
      timeout: Duration.seconds(5),
      logGroup: interceptorLogs,
      bundling: { format: lambdaNode.OutputFormat.CJS, target: 'node22', sourceMap: true, externalModules: [] },
      projectRoot: REPO_ROOT,
      depsLockFilePath: path.join(REPO_ROOT, 'package-lock.json'),
      description: 'REQUEST interceptor enforcing per-tool OAuth scopes on the Gateway',
    });

    const toolTargetLogs = new logs.LogGroup(this, 'ToolTargetLogs', {
      logGroupName: '/aws/lambda/travel-assistant-gateway-tools',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    /*
     * One Lambda for all three tools, dispatching on the tool name AgentCore passes in the
     * client context. Three functions would buy three cold starts and three log groups to
     * separate code that shares its HTTP client and its geocoder.
     */
    const toolTarget = new lambdaNode.NodejsFunction(this, 'GatewayToolTarget', {
      functionName: 'travel-assistant-gateway-tools',
      entry: path.join(REPO_ROOT, 'src/gateway/toolTarget.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      // Like the BFF, this function spends its life waiting on sockets, and that wait is
      // billed in GB-seconds — memory size multiplies the cost of doing nothing.
      memorySize: 256,
      // `get_weather` makes two upstream calls, each with a 5 s timeout of its own, so 15 s
      // lets the tool's own error handling report a slow upstream instead of the platform
      // killing the function with no span written.
      timeout: Duration.seconds(15),
      logGroup: toolTargetLogs,
      bundling: { format: lambdaNode.OutputFormat.CJS, target: 'node22', sourceMap: true, externalModules: [] },
      projectRoot: REPO_ROOT,
      depsLockFilePath: path.join(REPO_ROOT, 'package-lock.json'),
      description: 'Gateway target: Wikipedia, open-meteo and Wikimedia Commons tools',
    });

    // Scoped to these two functions by ARN. The docs are explicit that a wildcard here is
    // the mistake to avoid: the gateway role is assumable by a service and would then be
    // able to invoke every function in the account.
    gatewayRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [toolTarget.functionArn, interceptor.functionArn],
    }));

    // The same lesson the Runtime taught us, one component along: AgentCore creates its own
    // log group and cannot without this permission — and it stays READY while logging nowhere.
    gatewayRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
      resources: [
        `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/*`,
        `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/*:log-stream:*`,
      ],
    }));

    const gateway = new agentcore.CfnGateway(this, 'Gateway', {
      // Hyphens: gateway names are validated against `^([0-9a-zA-Z][-]?){1,100}$`, so
      // underscores are rejected — while `CfnRuntime` above requires them. `cdk synth`
      // reports this as a warning, not an error, so it is easy to deploy straight into.
      name: 'travel-assistant-gateway',
      description: 'Managed MCP server for the travel assistant tools',
      roleArn: gatewayRole.roleArn,
      protocolType: 'MCP',
      // CUSTOM_JWT, not IAM: the whole design (ADR-0004) is that the *caller's* Cognito
      // token reaches the Gateway, so the scopes it carries decide what the agent may do.
      // An IAM authorizer would authenticate the agent instead, and per-user scopes would
      // have nowhere left to be enforced.
      authorizerType: 'CUSTOM_JWT',
      authorizerConfiguration: {
        customJwtAuthorizer: {
          discoveryUrl:
            `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}/.well-known/openid-configuration`,
          // `allowedClients`, not `allowedAudience`: a Cognito client-credentials access
          // token carries `client_id` and no `aud` claim, so an audience check would reject
          // every token our machine client issues.
          allowedClients: [machineClient.userPoolClientId],
          // No `allowedScopes` here on purpose. That field is a gateway-wide gate — one
          // scope for every tool — and what we need is per-tool, which is the interceptor's job.
        },
      },
      interceptorConfigurations: [{
        interceptor: { lambda: { arn: interceptor.functionArn } },
        // REQUEST only. A RESPONSE interceptor could filter the tool catalogue by scope, and
        // that is deliberately not done: hiding a tool removes the very denial the
        // observability requirement asks us to be able to reconstruct.
        interceptionPoints: ['REQUEST'],
        inputConfiguration: {
          // Required for the design to work at all — the scopes live in the Authorization
          // header, and without this the interceptor is handed a request with no token and
          // has to fail closed on every call. It also means this Lambda holds a live access
          // token in memory, which is why a test asserts it never writes one to a log.
          passRequestHeaders: true,
        },
      }],
    });

    // Declared rather than left to AgentCore, for the same two reasons as the Runtime's:
    // an auto-created group never expires, and it would survive `cdk destroy`.
    new logs.LogGroup(this, 'GatewayLogs', {
      logGroupName: `/aws/bedrock-agentcore/gateways/${gateway.attrGatewayIdentifier}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    /*
     * The target. `toolDefinitions` derives the schema from the tools themselves, so the
     * contract the Gateway advertises cannot drift from the one the code implements.
     *
     * The target's name becomes a prefix on every tool it serves
     * (`travel_tools___get_weather`), which is why `TOOL_TARGET_NAME` is imported from the
     * same module the agent and the interceptor use to strip it.
     */
    const toolsTarget = new agentcore.CfnGatewayTarget(this, 'ToolTarget', {
      gatewayIdentifier: gateway.attrGatewayIdentifier,
      name: TOOL_TARGET_NAME,
      description: 'Keyless travel tools: place details, weather, photos',
      targetConfiguration: {
        mcp: {
          lambda: {
            lambdaArn: toolTarget.functionArn,
            toolSchema: { inlinePayload: toolDefinitions(GATEWAY_TOOLS) },
          },
        },
      },
      // The Gateway signs the Lambda invocation with its own role. The alternative types
      // (OAUTH, API_KEY) are for targets that need an outbound credential injected — which
      // is what `search_flights` would need, and the reason it is not here (ADR-0002).
      credentialProviderConfigurations: [{
        credentialProviderType: 'GATEWAY_IAM_ROLE',
        credentialProvider: { iamCredentialProvider: { service: 'lambda', region: this.region } },
      }],
    });
    toolsTarget.addResourceDependency(gateway);

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
        // Presence of this variable is what switches the agent from in-process tools to the
        // Gateway. `attrGatewayUrl` is the full MCP endpoint, ending in `/mcp`.
        GATEWAY_URL: gateway.attrGatewayUrl,
        NODE_ENV: 'production',
      },
    });
    runtime.addResourceDependency(memory);
    runtime.addResourceDependency(duffelCredentials);
    // The agent's first turn calls `tools/list`, so the target must exist before the runtime
    // is considered deployed — otherwise the first invocation after a deploy fails on an
    // empty catalogue and looks like a broken agent.
    runtime.addResourceDependency(toolsTarget);

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
    new CfnOutput(this, 'MemoryId', { value: memory.attrMemoryId });
    new CfnOutput(this, 'ApiUrl', { value: `${api.url}chat` });
    new CfnOutput(this, 'ApiKeyId', { value: apiKey.keyId });
    new CfnOutput(this, 'GatewayUrl', { value: gateway.attrGatewayUrl });
    new CfnOutput(this, 'GatewayId', { value: gateway.attrGatewayIdentifier });
  }
}
