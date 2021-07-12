import { PerformTasksCommand, ValidateTasksCommand } from '~commands/index';
import { IIntegrationTestContext, baseBeforeAll, baseAfterAll } from './base-integration-test';
import { ListStacksOutput, GetStackPolicyOutput, DescribeStacksOutput } from 'aws-sdk/clients/cloudformation';
import { ConsoleUtil } from '~util/console-util';

const basePathForScenario = './test/integration-tests/resources/scenario-update-stacks-tags/';

describe('when calling org-formation perform tasks', () => {
    let context: IIntegrationTestContext;
    let stackWithTags: DescribeStacksOutput;
    let stackWithoutTags: DescribeStacksOutput;

    beforeAll(async () => {
        try {
            jest.spyOn(ConsoleUtil, 'LogError').mockImplementation();
            context = await baseBeforeAll();
            await context.prepareStateBucket(basePathForScenario + '../state.json');
            const command = context.command;
            const { cfnClient } = context;

            await ValidateTasksCommand.Perform({ ...command, tasksFile: basePathForScenario + '1-deploy-stacks-with-tags.yml' })
            await PerformTasksCommand.Perform({ ...command, tasksFile: basePathForScenario + '1-deploy-stacks-with-tags.yml' });
            stackWithTags = await cfnClient.describeStacks({ StackName: 'test-with-stack-tags' }).promise();

            await PerformTasksCommand.Perform({ ...command, tasksFile: basePathForScenario + '2-deploy-stacks-without-tags.yml' });
            stackWithoutTags = await cfnClient.describeStacks({ StackName: 'test-with-stack-tags' }).promise();
            //
            await PerformTasksCommand.Perform({ ...command, tasksFile: basePathForScenario + '9-cleanup-stacks-with-tags.yml', performCleanup: true });
        } catch (err) {
            expect(err).toBeUndefined();
        }
    });

    test('stack has Tags after adding tags to update-stacks', () => {
        expect(stackWithTags.Stacks[0].Tags).toBeDefined();
        const tags = stackWithTags.Stacks[0].Tags!;
        const tag1 = tags.some(x => x.Key === 'Tag' && x.Value === 'tag-val1');
        const tag2 = tags.some(x => x.Key === 'AnotherTag' && x.Value === 'tag-val2');
        expect(tag1).toBe(true);
        expect(tag2).toBe(true);
    });

    test('stack has no Tags after removing tags from update-stacks', () => {
        expect(stackWithoutTags.Stacks[0].Tags).toHaveLength(0);
    });

    afterAll(async () => {
        await baseAfterAll(context);
    });
});