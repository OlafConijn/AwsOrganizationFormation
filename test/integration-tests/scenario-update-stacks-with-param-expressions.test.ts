import { ValidateTasksCommand, PerformTasksCommand } from "~commands/index";
import { IIntegrationTestContext, baseBeforeAll, baseAfterAll, sleepForTest } from "./base-integration-test";
import { DescribeStacksOutput, ListStacksOutput } from "aws-sdk/clients/cloudformation";

const basePathForScenario = './test/integration-tests/resources/scenario-cfn-parameter-expressions/';

describe('when importing value from another stack', () => {
    let context: IIntegrationTestContext;
    let describedBucketStack: DescribeStacksOutput;
    let describeBucketRoleStack: DescribeStacksOutput;
    let stacksAfterCleanup: ListStacksOutput;

    beforeAll(async () => {
        try{
            context = await baseBeforeAll();

            await context.prepareStateBucket(basePathForScenario + '../state.json');
            const { command, cfnClient } = context;

            await ValidateTasksCommand.Perform({...command, tasksFile: basePathForScenario + '1-deploy-update-stacks-with-param-expressions.yml' })
            await PerformTasksCommand.Perform({...command, tasksFile: basePathForScenario + '1-deploy-update-stacks-with-param-expressions.yml' });

            describedBucketStack = await cfnClient.describeStacks({StackName: 'scenario-export-bucket'}).promise();
            describeBucketRoleStack = await cfnClient.describeStacks({StackName: 'scenario-export-bucket-role'}).promise();

            await PerformTasksCommand.Perform({...command, tasksFile: basePathForScenario + '2-cleanup-update-stacks-with-param-expressions.yml', performCleanup: true });

            stacksAfterCleanup = await cfnClient.listStacks({StackStatusFilter: ['CREATE_COMPLETE', 'UPDATE_COMPLETE']}).promise();
        }catch(err) {
            expect(err.message).toBeUndefined();
        }
    });

    test('Stack parameter with CopyValue has value of Output', () =>{
        expect(describeBucketRoleStack).toBeDefined();

        const parameter = describeBucketRoleStack.Stacks[0].Parameters.find(x=>x.ParameterKey === 'bucketArn');
        const output = describedBucketStack.Stacks[0].Outputs[0];
        expect(output.ExportName).toBe('BucketArn');
        expect(parameter.ParameterValue).toBe(output.OutputValue);
    })

    test('Stack parameter with explicit accountId has value of Output', () =>{
        expect(describeBucketRoleStack).toBeDefined();

        const parameter = describeBucketRoleStack.Stacks[0].Parameters.find(x=>x.ParameterKey === 'bucketArn2');
        const output = describedBucketStack.Stacks[0].Outputs[0];
        expect(output.ExportName).toBe('BucketArn');
        expect(parameter.ParameterValue).toBe(output.OutputValue);
    })

    test('Stack parameter with arr has value', () =>{
        expect(describeBucketRoleStack).toBeDefined();

        const parameter = describeBucketRoleStack.Stacks[0].Parameters.find(x=>x.ParameterKey === 'paramArray');
        expect(parameter.ParameterValue).toBe('val1,val2');
    })

    test('Stack parameter with explicit accountId and region has value of Output', () =>{
        expect(describeBucketRoleStack).toBeDefined();

        const parameter = describeBucketRoleStack.Stacks[0].Parameters.find(x=>x.ParameterKey === 'bucketArn3');
        const output = describedBucketStack.Stacks[0].Outputs[0];
        expect(output.ExportName).toBe('BucketArn');
        expect(parameter.ParameterValue).toBe(output.OutputValue);
    })

    test('Stack parameter with logical account Id and region has value of Output', () =>{
        expect(describeBucketRoleStack).toBeDefined();

        const parameter = describeBucketRoleStack.Stacks[0].Parameters.find(x=>x.ParameterKey === 'bucketArn4');
        const output = describedBucketStack.Stacks[0].Outputs[0];
        expect(output.ExportName).toBe('BucketArn');
        expect(parameter.ParameterValue).toBe(output.OutputValue);
    })


    test('Stack parameter with !Ref gets resolved ', () =>{
        expect(describeBucketRoleStack).toBeDefined();

        const parameter = describeBucketRoleStack.Stacks[0].Parameters.find(x=>x.ParameterKey === 'masterAccountId');
        expect(parameter.ParameterValue).toBe('102625093955');
    })

    test('Stack parameter with numeric value gets converted to a string ', () =>{
        expect(describeBucketRoleStack).toBeDefined();

        const parameter = describeBucketRoleStack.Stacks[0].Parameters.find(x=>x.ParameterKey === 'numericValue');
        expect(parameter.ParameterValue).toBe('123');
    })

    test('Stack parameter with !GetAtt gets resolved ', () =>{
        expect(describeBucketRoleStack).toBeDefined();

        const parameter = describeBucketRoleStack.Stacks[0].Parameters.find(x=>x.ParameterKey === 'tagVal');
        expect(parameter.ParameterValue).toBe('tag-value');
    })

    test('Stack parameter with !GetAtt and CurrentAccount gets resolved ', () =>{
        expect(describeBucketRoleStack).toBeDefined();

        const parameter = describeBucketRoleStack.Stacks[0].Parameters.find(x=>x.ParameterKey === 'tagVal2');
        expect(parameter.ParameterValue).toBe('tag-value');
    })

    test('Stack parameter with !GetAtt and AWSAccount gets resolved ', () =>{
        expect(describeBucketRoleStack).toBeDefined();

        const parameter = describeBucketRoleStack.Stacks[0].Parameters.find(x=>x.ParameterKey === 'tagVal3');
        expect(parameter.ParameterValue).toBe('tag-value');
    })

    test('Stack parameter with !Ref and AWSAccount gets resolved ', () =>{
        expect(describeBucketRoleStack).toBeDefined();

        const parameter = describeBucketRoleStack.Stacks[0].Parameters.find(x=>x.ParameterKey === 'tagVal4');
        expect(parameter.ParameterValue).toBe('102625093955');
    })

    test('Stack parameter with !Sub gets resolved ', () =>{
        expect(describeBucketRoleStack).toBeDefined();

        const parameter = describeBucketRoleStack.Stacks[0].Parameters.find(x=>x.ParameterKey === 'someSubExpression');
        expect(parameter.ParameterValue).toBe('--102625093955--102625093955');
    })

    test('Stack parameter Ref on CurrentAccount gets resolved ', () =>{
        expect(describeBucketRoleStack).toBeDefined();

        const parameter = describeBucketRoleStack.Stacks[0].Parameters.find(x=>x.ParameterKey === 'currentAccount');
        expect(parameter.ParameterValue).toBe('102625093955');
    })

    test('CopyValue within Join gets resolved properly', () =>{
        expect(describeBucketRoleStack).toBeDefined();

        const parameter = describeBucketRoleStack.Stacks[0].Parameters.find(x=>x.ParameterKey === 'joinedCopyValue');
        const output = describedBucketStack.Stacks[0].Outputs[0];
        expect(output.ExportName).toBe('BucketArn');
        expect(parameter.ParameterValue).toBe(output.OutputValue + '-postfix');
    })

    test('cleanup removes deployed stacks', () => {
        expect(stacksAfterCleanup.StackSummaries.find(x=>x.StackName === 'scenario-export-bucket')).toBeUndefined();
        expect(stacksAfterCleanup.StackSummaries.find(x=>x.StackName === 'scenario-export-bucket-role')).toBeUndefined();
    });

    afterAll(async ()=> {
        await baseAfterAll(context);
    })
});