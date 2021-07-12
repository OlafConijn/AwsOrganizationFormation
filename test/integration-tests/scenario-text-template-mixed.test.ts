import { PerformTasksCommand, ValidateTasksCommand } from '~commands/index';
import { IIntegrationTestContext, baseBeforeAll } from './base-integration-test';
import { DescribeStacksOutput } from 'aws-sdk/clients/cloudformation';
import { NunjucksDebugSettings } from '~yaml-cfn/index';
import { PrintTasksCommand } from '~commands/print-tasks';
import { AwsUtil } from '~util/aws-util';

const basePathForScenario = './test/integration-tests/resources/scenario-text-template-mixed/';

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

      await AwsUtil.InitializeWithCurrentPartition();

      await ValidateTasksCommand.Perform({ ...command, tasksFile: basePathForScenario + '1-deploy.yml' })
      await PrintTasksCommand.Perform({ ...command, tasksFile: basePathForScenario + '1-deploy.yml' })
      await PerformTasksCommand.Perform({ ...command, tasksFile: basePathForScenario + '1-deploy.yml' });

      stackA = await cfnClient.describeStacks({ StackName: 'mixed-buckets-a' }).promise();
      stackB = await cfnClient.describeStacks({ StackName: 'mixed-buckets-b' }).promise();
      stackC = await cfnClient.describeStacks({ StackName: 'mixed-buckets-c' }).promise();

      await PerformTasksCommand.Perform({ ...command, tasksFile: basePathForScenario + '9-cleanup.yml', performCleanup: true });
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