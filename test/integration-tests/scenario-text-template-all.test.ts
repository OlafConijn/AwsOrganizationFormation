import { PerformTasksCommand, ValidateTasksCommand } from '~commands/index';
import { IIntegrationTestContext, baseBeforeAll } from './base-integration-test';
import { DescribeStacksOutput } from 'aws-sdk/clients/cloudformation';
import { NunjucksDebugSettings } from '~yaml-cfn/index';
import { PrintTasksCommand } from '~commands/print-tasks';

const basePathForScenario = './test/integration-tests/resources/scenario-text-template-all/';

describe('when calling org-formation perform tasks', () => {
  let context: IIntegrationTestContext;
  let stackA: DescribeStacksOutput;
  let stackB: DescribeStacksOutput;
  let stackC: DescribeStacksOutput;

  beforeAll(async () => {
    try {
      NunjucksDebugSettings.debug = true;
      context = await baseBeforeAll();
      await context.prepareStateBucket(basePathForScenario + '../state.json');
      const command = context.command;
      const { cfnClient } = context;

      await ValidateTasksCommand.Perform({ ...command, tasksFile: basePathForScenario + '1-deploy-text-templated-things.yml' })
      await PrintTasksCommand.Perform({ ...command, tasksFile: basePathForScenario + '1-deploy-text-templated-things.yml' })
      await PerformTasksCommand.Perform({ ...command, tasksFile: basePathForScenario + '1-deploy-text-templated-things.yml' });

      stackA = await cfnClient.describeStacks({ StackName: 'buckets-a' }).promise();
      stackB = await cfnClient.describeStacks({ StackName: 'buckets-b' }).promise();
      stackC = await cfnClient.describeStacks({ StackName: 'buckets-c' }).promise();

      await PerformTasksCommand.Perform({ ...command, tasksFile: basePathForScenario + '9-cleanup-text-templated-things.yml', performCleanup: true });
    } catch (err) {
      expect(err.message ?? err).toBeUndefined();
    }
  });

  test('stack was deployed three times', () => {
    for (const stack of [stackA, stackB, stackC]) {
      expect(stack).toBeDefined();
      expect(stack.Stacks.length).toBe(1);
      expect(stack.Stacks[0]).toBeDefined();
      expect(stack.Stacks[0].StackStatus).toBe('CREATE_COMPLETE');
    }
  });

});