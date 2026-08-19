import { App } from 'aws-cdk-lib';
import { TravelAssistantStack } from '../lib/travel-assistant-stack.js';

const app = new App();

new TravelAssistantStack(app, 'TravelAssistantStack', {
  env: { account: '687222805898', region: 'us-east-1' },
  description: 'AI travel assistant on Bedrock AgentCore (mentoring project)',
});
