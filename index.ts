
import * as AWS from 'aws-sdk';
import { Organizations, STS } from 'aws-sdk';
import { AssumeRoleRequest } from 'aws-sdk/clients/sts';
import { SharedIniFileCredentialsOptions } from 'aws-sdk/lib/credentials/shared_ini_file_credentials';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import * as ini from 'ini';
import { AwsOrganization } from './src/aws-provider/aws-organization';
import { AwsOrganizationReader } from './src/aws-provider/aws-organization-reader';
import { AwsOrganizationWriter } from './src/aws-provider/aws-organization-writer';
import { BuildConfiguration } from './src/build-tasks/build-configuration';
import { BuildRunner } from './src/build-tasks/build-runner';
import { CloudFormationBinder } from './src/cfn-binder/cfn-binder';
import { CfnTaskRunner } from './src/cfn-binder/cfn-task-runner';
import { ChangeSetProvider } from './src/change-set/change-set-provider';
import { ConsoleUtil } from './src/console-util';
import { OrganizationBinder } from './src/org-binder/org-binder';
import { TaskRunner } from './src/org-binder/org-task-runner';
import { TaskProvider } from './src/org-binder/org-tasks-provider';
import { OrgFormationError } from './src/org-formation-error';
import { IOrganizationBinding, ITemplate, ITemplateOverrides, TemplateRoot } from './src/parser/parser';
import { ICfnTarget, PersistedState } from './src/state/persisted-state';
import { S3StorageProvider } from './src/state/storage-provider';
import { DefaultTemplateWriter } from './src/writer/default-template-writer';

export async function updateTemplate(templateFile: string, command: ICommandArgs): Promise<void> {
    const template = TemplateRoot.create(templateFile);

    const state = await getState(command);
    const binder = await getOrganizationBinder(template, state);

    const tasks = binder.enumBuildTasks();
    if (tasks.length === 0) {
        ConsoleUtil.LogInfo('organization up to date, no work to be done.');
    } else {
        await TaskRunner.RunTasks(tasks);
        ConsoleUtil.LogInfo('done');
    }

    state.setPreviousTemplate(template.source);
    await state.save();
}

export async function performTasks(path: string, command: ICommandArgs): Promise<void> {
    const config = new BuildConfiguration(path);
    const tasks = config.enumBuildTasks(command);
    await BuildRunner.RunTasks(tasks);
}

export async function updateAccountResources(templateFile: string, command: IUpdateStackCommandArgs): Promise<void> {
    if (!command.stackName) {
        throw new OrgFormationError(`missing option --stack-name <stack-name>`);
    }

    const template = createTemplateUsingOverrides(command, templateFile);
    const parameters = parseStackParameters(command);
    const state = await getState(command);
    const cfnBinder = new CloudFormationBinder(command.stackName, template, state, parameters, command.terminationProtection);

    const cfnTasks = cfnBinder.enumTasks();
    if (cfnTasks.length === 0) {
        ConsoleUtil.LogInfo(`stack ${command.stackName} already up to date.`);
    } else {
        await CfnTaskRunner.RunTasks(cfnTasks, command.stackName);
        ConsoleUtil.LogInfo('done');
    }

    state.setPreviousTemplate(template.source);
    await state.save();
}

export async function printAccountStacks(templateFile: string, command: IUpdateStackCommandArgs): Promise<void> {

    if (!command.stackName) {
        throw new OrgFormationError(`missing option --stack-name <stack-name>`);
    }
    const template = createTemplateUsingOverrides(command, templateFile);
    const parameters = parseStackParameters(command);
    const state = await getState(command);
    const cfnBinder = new CloudFormationBinder(command.stackName, template, state, parameters);

    const bindings = cfnBinder.enumBindings();
    for (const binding of bindings) {
        console.log(`template for account ${binding.accountId} and region ${binding.region}`);
        const templateBody = binding.template.createTemplateBody();
        console.log(templateBody);
    }
}

export async function deleteAccountStacks(stackName: string, command: ICommandArgs): Promise<void> {

    const state = await getState(command);
    const orgTemplate = JSON.parse(state.getPreviousTemplate()) as ITemplate;
    delete orgTemplate.Resources;
    const emptyTemplate = TemplateRoot.createFromContents(JSON.stringify(orgTemplate));

    const cfnBinder = new CloudFormationBinder(stackName, emptyTemplate, state);

    const cfnTasks = cfnBinder.enumTasks();
    if (cfnTasks.length === 0) {
        ConsoleUtil.LogInfo('no work to be done.');
    } else {
        await CfnTaskRunner.RunTasks(cfnTasks, stackName);
        ConsoleUtil.LogInfo('done');
    }

    state.setPreviousTemplate(emptyTemplate.source);
    await state.save();
}

export async function describeAccountStacks(stackName: string, command: ICommandArgs): Promise<void> {
    if (typeof stackName === 'string') {
        command.stackName = stackName;
    }

    const state = await getState(command);
    const record: Record<string, ICfnTarget[]> = {};
    for (const stack of state.listStacks()) {
        if (command.stackName && stack !== command.stackName) {
            continue;
        }
        record[stack] = [];
        for (const target of state.enumTargets(stack)) {
            record[stack].push(target);
        }

    }
    console.log(JSON.stringify(record, null, 2));
}

export async function generateTemplate(filePath: string, command: ICommandArgs): Promise<void> {
    const storageProvider = await initializeAndGetStorageProvider(command);

    const organizations = new Organizations({ region: 'us-east-1' });
    const awsReader = new AwsOrganizationReader(organizations);
    const awsOrganization = new AwsOrganization(awsReader);
    const writer = new DefaultTemplateWriter(awsOrganization);
    const template = await writer.generateDefaultTemplate();
    const templateContents = template.template.replace(/( *)-\n\1 {2}/g, '$1- ');
    writeFileSync(filePath, templateContents);

    template.state.setPreviousTemplate(templateContents);
    await template.state.save(storageProvider);

}

export async function createChangeSet(templateFile: string, command: ICommandArgs): Promise<void> {
    const template = TemplateRoot.create(templateFile);

    const state = await getState(command);
    const binder = await getOrganizationBinder(template, state);

    const stateBucketName = await GetStateBucketName(command);
    const provider = new ChangeSetProvider(stateBucketName);
    const tasks = binder.enumBuildTasks();

    const changeSet = await provider.createChangeSet(command.changeSetName, template, tasks);

    const contents = JSON.stringify(changeSet, null, 2);
    console.log(contents);

}

export async function executeChangeSet(changeSetName: string, command: ICommandArgs): Promise<void> {
    initialize(command);
    const stateBucketName = await GetStateBucketName(command);
    const provider = new ChangeSetProvider(stateBucketName);
    const changeSetObj = await provider.getChangeSet(changeSetName);
    if (!changeSetObj) {
        ConsoleUtil.LogError(`change set '${changeSetName}' not found.`);
        return;
    }
    const template = new TemplateRoot(changeSetObj.template, './');
    const state = await getState(command);
    const binder = await getOrganizationBinder(template, state);
    const tasks = binder.enumBuildTasks();
    const changeSet = ChangeSetProvider.CreateChangeSet(tasks, changeSetName);
    if (JSON.stringify(changeSet) !== JSON.stringify(changeSetObj.changeSet)) {
        ConsoleUtil.LogError(`AWS organization state has changed since creating change set.`);
        return;
    }
    await TaskRunner.RunTasks(tasks);
    state.setPreviousTemplate(template.source);
    await state.save();
}

function parseStackParameters(command: IUpdateStackCommandArgs) {
    if (command.parameters && typeof command.parameters === 'object') {
        return command.parameters;
    }
    const parameters: Record<string, string> = {};
    if (command.parameters && typeof command.parameters === 'string') {
        const parameterParts = command.parameters.split(' ');
        for (const parameterPart of parameterParts) {
            const parameterAttributes = parameterPart.split(',');
            if (parameterAttributes.length === 1) {
                const parts = parameterAttributes[0].split('=');
                if (parts.length !== 2) {
                    throw new Error(`error reading parameter ${parameterAttributes[0]}. Expected either key=val or ParameterKey=key,ParameterVaue=val.`);
                }
                parameters[parts[0]] = parts[1];
            } else {
                const key = parameterAttributes.find((x) => x.startsWith('ParameterKey='));
                const value = parameterAttributes.find((x) => x.startsWith('ParameterValue='));
                if (key === undefined || value === undefined) {
                    throw new Error(`error reading parameter ${parameterAttributes[0]}. Expected ParameterKey=key,ParameterVaue=val`);
                }
                parameters[key] = value;
            }
        }
    }

    return parameters;
}

function createTemplateUsingOverrides(command: IUpdateStackCommandArgs, templateFile: string) {
    const templateOverrides: ITemplateOverrides = {};

    if (command.stackDescription) {
        templateOverrides.Description = command.stackDescription;
    }
    if (command.organizationBinding) {
        templateOverrides.OrganizationBinding = command.organizationBinding;
    }
    if (command.organizationBindingRegion) {
        templateOverrides.OrganizationBindingRegion = command.organizationBindingRegion;
    }
    const template = TemplateRoot.create(templateFile, templateOverrides);
    return template;
}

export interface ICommandArgs {
    profile: string;
    stateBucketName: string;
    stateObject: string;
    stateBucketRegion: string;
    changeSetName: string;
    stackName: string;
}

export interface IUpdateStackCommandArgs extends ICommandArgs {
    stackDescription?: string;
    parameters?: string;
    organizationBinding?: IOrganizationBinding;
    organizationBindingRegion?: string | string[];
    terminationProtection?: boolean;
}

async function getOrganizationBinder(template: TemplateRoot, state: PersistedState) {
    const organizations = new Organizations({ region: 'us-east-1' });
    const awsReader = new AwsOrganizationReader(organizations);
    const awsOrganization = new AwsOrganization(awsReader);
    await awsOrganization.initialize();
    const awsWriter = new AwsOrganizationWriter(organizations, awsOrganization);
    const taskProvider = new TaskProvider(template, state, awsWriter);
    const binder = new OrganizationBinder(template, state, taskProvider);
    return binder;
}

async function getState(command: ICommandArgs) {
    const storageProvider = await initializeAndGetStorageProvider(command);
    try {
        const state = await PersistedState.Load(storageProvider);
        return state;
    } catch (err) {
        if (err && err.code === 'NoSuchBucket') {
            throw new OrgFormationError(`unable to load previously committed state, reason: bucket '${storageProvider.bucketName}' does not exist in current account.`);
        }
        throw err;
    }
}

async function initializeAndGetStorageProvider(command: ICommandArgs) {
    await initialize(command);
    return GetStorageProvider(command.stateObject, command);
}

async function initialize(command: ICommandArgs) {
    try {

        await customInitializationIncludingMFASupport(command);

    } catch (err) {
        if (err instanceof OrgFormationError) {
            throw err;
        }
        ConsoleUtil.LogInfo(`custom initialization failed, not support for MFA token\n${err}`);
    }

    const options: SharedIniFileCredentialsOptions = {};
    if (command.profile) {
        options.profile = command.profile;
    }

    const credentials = new AWS.SharedIniFileCredentials(options);
    if (credentials.accessKeyId) {
        AWS.config.credentials = credentials;
    }
}

async function customInitializationIncludingMFASupport(command: ICommandArgs): Promise<void> {
    const profileName = command.profile ? command.profile : 'default';
    const homeDir = require('os').homedir();
    // todo: add support for windows?
    if (!existsSync(homeDir + '/.aws/config')) {
        return;
    }
    const awsconfig = readFileSync(homeDir + '/.aws/config').toString('utf8');
    const contents = ini.parse(awsconfig);
    const profile = contents['profile ' + profileName];
    if (profile && profile.source_profile) {
        const awssecrets = readFileSync(homeDir + '/.aws/credentials').toString('utf8');
        const secrets = ini.parse(awssecrets);
        const creds = secrets[profile.source_profile];
        const sts = new STS({ credentials: { accessKeyId: creds.aws_access_key_id, secretAccessKey: creds.aws_secret_access_key } });

        const token = await ConsoleUtil.Readline(`👋 Enter MFA code for ${profile.mfa_serial}`);
        const assumeRoleReq: AssumeRoleRequest = {
            RoleArn: profile.role_arn,
            RoleSessionName: 'organization-build',
            SerialNumber: profile.mfa_serial,
            TokenCode: token,
        };

        try {
            const tokens = await sts.assumeRole(assumeRoleReq).promise();
            AWS.config.credentials = { accessKeyId: tokens.Credentials.AccessKeyId, secretAccessKey: tokens.Credentials.SecretAccessKey, sessionToken: tokens.Credentials.SessionToken };
        } catch (err) {
            throw new OrgFormationError(`unable to assume role, error: \n${err}`);
        }
    }
}

async function GetStorageProvider(objectKey: string, command: ICommandArgs) {
    const stateBucketName = await GetStateBucketName(command);
    // ConsoleUtil.LogDebug(`getting state from s3://${stateBucketName}/${objectKey}`);
    const getBucketRegionFn = async () => await GetBucketRegion(command.stateBucketRegion);
    const storageProvider = await S3StorageProvider.Create(stateBucketName, objectKey, true, getBucketRegionFn);
    return storageProvider;
}

async function GetBucketRegion(region: string) {
    if (region) { return region; }

    const readRegion = await ConsoleUtil.Readline('👋 Enter the region for the state bucket (us-east-1)');
    if (readRegion === '') { return undefined; }
    return readRegion;
}

async function GetStateBucketName(command: ICommandArgs): Promise<string> {
    const bucketName = command.stateBucketName || 'organization-formation-${AWS::AccountId}';
    if (bucketName.indexOf('${AWS::AccountId}') >= 0) {
        const accountId = await getCurrentAccountId();
        return bucketName.replace('${AWS::AccountId}', accountId);
    }
    return bucketName;
}

async function getCurrentAccountId(): Promise<string> {
    const stsClient = new STS();
    const caller = await stsClient.getCallerIdentity().promise();
    return caller.Account;
}
