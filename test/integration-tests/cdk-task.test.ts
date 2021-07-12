import { PerformTasksCommand, ValidateTasksCommand, RemoveCommand } from '~commands/index';
import { IIntegrationTestContext, baseBeforeAll, baseAfterAll } from './base-integration-test';
import { ChildProcessUtility } from '~util/child-process-util';
import { GetObjectOutput } from 'aws-sdk/clients/s3';
import { ExecOptions } from 'child_process';

const basePathForScenario = './test/integration-tests/resources/scenario-cdk-task/';

describe('when calling org-formation perform tasks', () => {
    let context: IIntegrationTestContext;

    let spawnProcessAfterDeploy2Targets: jest.MockContext<any, any>;
    let stateAfterDeploy2Targets: GetObjectOutput;
    let spawnProcessAfterDeploy1Target: jest.MockContext<any, any>;
    let stateAfterDeploy1Target: GetObjectOutput;
    let stateAfterRemoveTask: GetObjectOutput;
    let spawnProcessAfterRemoveTask: jest.MockContext<any, any>;
    let spawnProcessMock: jest.SpyInstance;
    let spawnProcessAfterUpdateWithParameters: jest.MockContext<any, any>;
    let stateAfterUpdateWithParameters: GetObjectOutput;
    let stateAfterCleanup: GetObjectOutput;
    let spawnProcessAfterCleanup: jest.MockContext<any, any>;

    beforeAll(async () => {
        spawnProcessMock = jest.spyOn(ChildProcessUtility, 'SpawnProcess');
        context = await baseBeforeAll();

        await context.prepareStateBucket(basePathForScenario + '../state.json');
        const { command, stateBucketName, s3client } = context;

        await ValidateTasksCommand.Perform({ ...command, tasksFile: basePathForScenario + '1-deploy-cdk-workload-2targets.yml' })

        spawnProcessMock.mockReset();
        await PerformTasksCommand.Perform({ ...command, tasksFile: basePathForScenario + '1-deploy-cdk-workload-2targets.yml' });
        spawnProcessAfterDeploy2Targets = spawnProcessMock.mock;
        stateAfterDeploy2Targets = await s3client.getObject({ Bucket: stateBucketName, Key: command.stateObject }).promise();

        spawnProcessMock.mockReset();
        await PerformTasksCommand.Perform({ ...command, tasksFile: basePathForScenario + '2-update-cdk-workload-with-parameters.yml' })
        spawnProcessAfterUpdateWithParameters = spawnProcessMock.mock;
        stateAfterUpdateWithParameters = await s3client.getObject({ Bucket: stateBucketName, Key: command.stateObject }).promise();

        spawnProcessMock.mockReset();
        await PerformTasksCommand.Perform({ ...command, tasksFile: basePathForScenario + '3-deploy-cdk-workload-1target.yml' })
        spawnProcessAfterDeploy1Target = spawnProcessMock.mock;
        stateAfterDeploy1Target = await s3client.getObject({ Bucket: stateBucketName, Key: command.stateObject }).promise();

        spawnProcessMock.mockReset();
        await PerformTasksCommand.Perform({ ...command, tasksFile: basePathForScenario + '4-remove-cdk-workload-task.yml', performCleanup: false })
        spawnProcessAfterRemoveTask = spawnProcessMock.mock;
        stateAfterRemoveTask = await s3client.getObject({ Bucket: stateBucketName, Key: command.stateObject }).promise();

        spawnProcessMock.mockReset();
        await RemoveCommand.Perform({ ...command, type: 'cdk', name: 'CdkWorkload' });
        spawnProcessAfterCleanup = spawnProcessMock.mock;
        stateAfterCleanup = await s3client.getObject({ Bucket: stateBucketName, Key: command.stateObject }).promise();
    });

    test('after deploy 2 targets npm ci was called twice', () => {
        expect(spawnProcessAfterDeploy2Targets.calls[0][0]).toEqual(expect.stringContaining('npm i'));
        expect(spawnProcessAfterDeploy2Targets.calls[1][0]).toEqual(expect.stringContaining('npm i'));
    });

    test('after deploy 2 targets npx sls deploy was called twice', () => {
        expect(spawnProcessAfterDeploy2Targets.calls[0][0]).toEqual(expect.stringContaining('npx cdk deploy'));
        expect(spawnProcessAfterDeploy2Targets.calls[1][0]).toEqual(expect.stringContaining('npx cdk deploy'));
    });

    test('after deploy 2 targets CDK_DEFAULT_REGION and CDK_DEFAULT_ACCOUNT are set', () => {
        const contexts: ExecOptions[] = [spawnProcessAfterDeploy2Targets.calls[0][1], spawnProcessAfterDeploy2Targets.calls[1][1]];

        const noRegion = contexts.find(x => x.env['CDK_DEFAULT_REGION'] === undefined);
        const noAccount = contexts.find(x => x.env['CDK_DEFAULT_ACCOUNT'] === undefined);

        expect(noRegion).toBeUndefined();
        expect(noAccount).toBeUndefined();
    });

    test('after deploy 2 targets CDK_DEPLOY_REGION and CDK_DEPLOY_ACCOUNT are set', () => {
        const contexts: ExecOptions[] = [spawnProcessAfterDeploy2Targets.calls[0][1], spawnProcessAfterDeploy2Targets.calls[1][1]];

        const noRegion = contexts.find(x => x.env['CDK_DEPLOY_REGION'] === undefined);
        const noAccount = contexts.find(x => x.env['CDK_DEPLOY_ACCOUNT'] === undefined);

        expect(noRegion).toBeUndefined();
        expect(noAccount).toBeUndefined();
    });


    test('when updating with parameters, parameters are passed to CDK invocation', () => {
        const command0 = spawnProcessAfterUpdateWithParameters.calls[0][0];
        const command1 = spawnProcessAfterUpdateWithParameters.calls[1][0];
        expect(command0).toEqual(expect.stringContaining('param2=Account A'));
        expect(command0 !== command1).toBeTruthy();
    });

    test('GetAtt to tag resolves from within parameters', () => {
        const command0: string = spawnProcessAfterUpdateWithParameters.calls[0][0];
        const command1: string = spawnProcessAfterUpdateWithParameters.calls[1][0];
        const foundTagValue1 = [command0, command1].some(x => x.includes('-c \'param3=TagValue1\''))
        const foundTagValue2 = [command0, command1].some(x => x.includes('-c \'param3=TagValue2\''))
        expect(foundTagValue1).toBe(true);
        expect(foundTagValue2).toBe(true);
    });

    test('when updating, no parameter is left unresolved', () => {
        const command0 = spawnProcessAfterUpdateWithParameters.calls[0][0];
        const command1 = spawnProcessAfterUpdateWithParameters.calls[1][0];
        expect(command0).toEqual(expect.not.stringContaining('[object object]'));
        expect(command1).toEqual(expect.not.stringContaining('[object object]'));
    });


    test('after deploy 2 targets state contains both deployed workload', () => {
        const stateAsString = stateAfterDeploy2Targets.Body.toString();
        const state = JSON.parse(stateAsString);
        expect(state).toBeDefined();
        expect(state.targets).toBeDefined();
        expect(state.targets['cdk']).toBeDefined();
        expect(state.targets['cdk']['default']['default']['CdkWorkload']).toBeDefined();
        expect(state.targets['cdk']['default']['default']['CdkWorkload']['102625093955']).toBeDefined();
        expect(state.targets['cdk']['default']['default']['CdkWorkload']['102625093955']['eu-central-1']).toBeDefined();
        expect(state.targets['cdk']['default']['default']['CdkWorkload']['340381375986']).toBeDefined();
        expect(state.targets['cdk']['default']['default']['CdkWorkload']['340381375986']['eu-central-1']).toBeDefined();
    });

    // test('after deploy workload state contains tracked task', () => {
    //     const stateAsString = stateAfterDeploy2Targets.Body.toString();
    //     const state = JSON.parse(stateAsString);
    //     expect(state).toBeDefined();
    //     expect(state.trackedTasks).toBeDefined();
    // });

    test('after deploy 1 targets cdk destroy was called', () => {
        expect(spawnProcessAfterDeploy1Target.calls.length).toBe(1);
        expect(spawnProcessAfterDeploy1Target.calls[0][0]).toEqual(expect.stringContaining('npx cdk destroy'));
    })

    test('after deploy 1 targets state does not contain removed target workload', () => {
        const stateAsString = stateAfterDeploy1Target.Body.toString();
        const state = JSON.parse(stateAsString);
        expect(state).toBeDefined();
        expect(state.targets).toBeDefined();
        expect(state.targets['cdk']['default']['default']['CdkWorkload']['102625093955']).toBeUndefined();
    });

    test('after removing task cdk destroy was not called', () => {
        expect(spawnProcessAfterRemoveTask.calls.length).toBe(0);
    })

    test('after removing task state does contain removed target workload', () => {
        const stateAsString = stateAfterRemoveTask.Body.toString();
        const state = JSON.parse(stateAsString);
        expect(state).toBeDefined();
        expect(state.targets).toBeDefined();
        expect(state.targets['cdk']).toBeDefined();
    });

    test('after cleanup cdk destroy was called', () => {
        expect(spawnProcessAfterCleanup.calls.length).toBe(1);
        expect(spawnProcessAfterCleanup.calls[0][0]).toEqual(expect.stringContaining('npx cdk destroy'));
    })

    test('after cleanup state does not contain removed target workload', () => {
        const stateAsString = stateAfterCleanup.Body.toString();
        const state = JSON.parse(stateAsString);
        expect(state).toBeDefined();
        expect(state.targets).toBeDefined();
        expect(state.targets['cdk']).toBeUndefined();
    });


    afterAll(async () => {
        await baseAfterAll(context);
    });
});