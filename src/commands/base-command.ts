import path from 'path';
import { readFileSync } from 'fs';
import { Organizations } from 'aws-sdk';
import { Command } from 'commander';
import RC from 'rc';
import { CredentialsOptions } from 'aws-sdk/lib/credentials';
import { AwsUtil } from '../util/aws-util';
import { ConsoleUtil } from '../util/console-util';
import { OrgFormationError } from '../org-formation-error';
import { IPerformTasksCommandArgs } from './perform-tasks';
import { IPrintTasksCommandArgs } from './print-tasks';
import { AwsOrganization } from '~aws-provider/aws-organization';
import { AwsOrganizationReader } from '~aws-provider/aws-organization-reader';
import { AwsOrganizationWriter } from '~aws-provider/aws-organization-writer';
import { OrganizationBinder } from '~org-binder/org-binder';
import { TaskProvider } from '~org-binder/org-tasks-provider';
import { TemplateRoot } from '~parser/parser';
import { PersistedState } from '~state/persisted-state';
import { S3StorageProvider } from '~state/storage-provider';
import { DefaultTemplate, DefaultTemplateWriter } from '~writer/default-template-writer';
import { CfnParameters } from '~core/cfn-parameters';
import { Validator } from '~parser/validator';
import { CfnExpressionResolver } from '~core/cfn-expression-resolver';
import { NunjucksDebugSettings } from '~yaml-cfn/index';

const DEFAULT_STATE_OBJECT = 'state.json';

export abstract class BaseCliCommand<T extends ICommandArgs> {

    protected command: Command;
    protected firstArg: any;

    static CliCommandArgs: ICommandArgs;
    static StateBucketName: string;

    static async CreateAdditionalArgsForInvocation(): Promise<string> {
        let additionalArgs = '';
        const cliArgs = BaseCliCommand.CliCommandArgs;
        if (cliArgs) {
            const profile = cliArgs.profile;
            const stateBucketName = cliArgs.stateBucketName;
            const stateObject = cliArgs.stateObject;

            if (profile !== undefined) {
                additionalArgs += `--profile ${profile} `;
            }

            const defaultStateBucketName = await BaseCliCommand.GetStateBucketName(undefined);

            if (stateBucketName !== undefined && stateBucketName !== defaultStateBucketName) {
                additionalArgs += `--state-bucket-name ${stateBucketName} `;
            }

            if (stateObject !== undefined && stateObject !== DEFAULT_STATE_OBJECT) {
                additionalArgs += `--state-object ${stateObject} `;
            }
        }
        return additionalArgs;
    }

    constructor(command?: Command, name?: string, description?: string, firstArgName?: string, private rc?: Record<string, any>) {
        if (command !== undefined && name !== undefined) {
            this.command = command.command(name);
            if (description !== undefined) {
                this.command.description(description);
            }
            this.command.allowUnknownOption(false);
            this.addOptions(this.command);
            this.command.action(async (firstArg: string) => {
                if (firstArgName && (typeof firstArg !== 'object')) {
                    this.command[firstArgName] = firstArg;
                }
                this.invoke();
            });
        }
    }

    public storeCommand(command: ICommandArgs): void {
        if (BaseCliCommand.CliCommandArgs === undefined) {
            BaseCliCommand.CliCommandArgs = command;
        }
    }

    public async generateDefaultTemplate(defaultBuildAccessRoleName?: string): Promise<DefaultTemplate> {
        const organizations = new Organizations({ region: 'us-east-1' });
        const awsReader = new AwsOrganizationReader(organizations);
        const awsOrganization = new AwsOrganization(awsReader);
        const writer = new DefaultTemplateWriter(awsOrganization);
        writer.DefaultBuildProcessAccessRoleName = defaultBuildAccessRoleName;
        const template = await writer.generateDefaultTemplate();
        template.template = template.template.replace(/( *)-\n\1 {2}/g, '$1- ');
        const parsedTemplate = TemplateRoot.createFromContents(template.template, './');
        template.state.setPreviousTemplate(parsedTemplate.source);
        return template;
    }

    public async getState(command: ICommandArgs): Promise<PersistedState> {
        if (command.state) {
            return command.state;
        }
        const storageProvider = await this.getStateStorageProvider(command);
        BaseCliCommand.StateBucketName = storageProvider.bucketName;
        const accountId = await AwsUtil.GetMasterAccountId();

        try {
            const state = await PersistedState.Load(storageProvider, accountId);
            if (command.organizationStateObject !== undefined) {
                const orgStorageProvider = await this.getOrganizationStateStorageProvider(command);
                const orgState = await PersistedState.Load(orgStorageProvider, accountId);
                state.setReadonlyOrganizationState(orgState);
            }
            command.state = state;
            return state;
        } catch (err) {
            if (err && err.code === 'NoSuchBucket') {
                throw new OrgFormationError(`unable to load previously committed state, reason: bucket '${storageProvider.bucketName}' does not exist in current account.`);
            }
            throw err;
        }
    }

    public async invoke(): Promise<void> {
        try {
            await this.initialize(this.command as any as ICommandArgs);
            await this.performCommand(this.command as any as T);
        } catch (err) {
            if (err instanceof OrgFormationError) {
                ConsoleUtil.LogError(err.message);
            } else {
                if (err.code && err.requestId) {
                    ConsoleUtil.LogError(`error: ${err.code}, aws-request-id: ${err.requestId}`);
                    ConsoleUtil.LogError(err.message);

                } else {
                    ConsoleUtil.LogError('unexpected error occurred...', err);
                }
            }
            process.exitCode = 1;
        }
    }
    protected abstract performCommand(command: T): Promise<void>;

    protected addOptions(command: Command): void {
        command.option('--state-bucket-name [state-bucket-name]', 'bucket name that contains state file', 'organization-formation-${AWS::AccountId}');
        command.option('--state-object [state-object]', 'key for object used to store state', DEFAULT_STATE_OBJECT);
        command.option('--profile [profile]', 'aws profile to use');
        command.option('--print-stack', 'will print stack traces for errors');
        command.option('--verbose', 'will enable debug logging');
        command.option('--no-color', 'will disable colorization of console logs');
        command.option('--master-account-id [master-account-id]', 'run org-formation on a build account that functions as a delegated master account');
    }

    protected async getOrganizationBinder(template: TemplateRoot, state: PersistedState): Promise<OrganizationBinder> {
        let roleInMasterAccount: string;
        if (template.organizationSection.masterAccount) {
            roleInMasterAccount = template.organizationSection.masterAccount.buildAccessRoleName;
        }
        const masterAccountId = await AwsUtil.GetMasterAccountId();
        const organizations = await AwsUtil.GetOrganizationsService(masterAccountId, roleInMasterAccount);
        const crossAccountConfig = { masterAccountId, masterAccountRoleName: roleInMasterAccount };

        const awsReader = new AwsOrganizationReader(organizations, crossAccountConfig);
        const awsOrganization = new AwsOrganization(awsReader);
        await awsOrganization.initialize();
        const awsWriter = new AwsOrganizationWriter(organizations, awsOrganization, crossAccountConfig);
        const taskProvider = new TaskProvider(template, state, awsWriter);
        const binder = new OrganizationBinder(template, state, taskProvider);
        return binder;
    }

    protected async createOrGetStateBucket(command: ICommandArgs, region: string, accountId?: string, credentials?: CredentialsOptions): Promise<S3StorageProvider> {
        const storageProvider = await this.getStateStorageProvider(command, accountId, credentials);
        try {
            await storageProvider.create(region);
        } catch (err) {
            if (err && err.code === 'BucketAlreadyOwnedByYou') {
                return storageProvider;
            }
            throw err;
        }
        return storageProvider;
    }

    protected async getStateStorageProvider(command: ICommandArgs, accountId?: string, credentials?: CredentialsOptions): Promise<S3StorageProvider> {
        const objectKey = command.stateObject;
        const stateBucketName = await BaseCliCommand.GetStateBucketName(command.stateBucketName, accountId);
        const storageProvider = await S3StorageProvider.Create(stateBucketName, objectKey, credentials);
        return storageProvider;
    }

    protected async getOrganizationStateStorageProvider(command: ICommandArgs): Promise<S3StorageProvider> {
        const objectKey = command.organizationStateObject;
        const stateBucketName = await BaseCliCommand.GetStateBucketName(command.organizationStateBucketName || command.stateBucketName);
        const storageProvider = await S3StorageProvider.Create(stateBucketName, objectKey);
        return storageProvider;
    }

    protected async getOrganizationFileStorageProvider(command: IPerformTasksCommandArgs): Promise<S3StorageProvider> {
        const objectKey = command.organizationObject;
        const stateBucketName = await BaseCliCommand.GetStateBucketName(command.stateBucketName);
        const storageProvider = await S3StorageProvider.Create(stateBucketName, objectKey);
        return storageProvider;
    }

    protected static async GetStateBucketName(stateBucketName: string, accountId?: string): Promise<string> {
        const bucketName = stateBucketName || 'organization-formation-${AWS::AccountId}';
        if (bucketName.indexOf('${AWS::AccountId}') >= 0) {
            if (accountId === undefined) {
                accountId = await AwsUtil.GetBuildProcessAccountId();
            }
            return bucketName.replace('${AWS::AccountId}', accountId);
        }
        return bucketName;
    }

    protected parseCfnParameters(commandParameters?: string | undefined | {}): Record<string, string> {

        if (typeof commandParameters === 'object') {
            return commandParameters;
        }
        if (typeof commandParameters === 'string') {
            return CfnParameters.ParseParameterValues(commandParameters);
        }

        return {};
    }

    protected async initialize(command: ICommandArgs): Promise<void> {
        if (command.initialized) { return; }

        // create a copy of `command` to ensure no circular references
        ConsoleUtil.LogDebug(`initializing, arguments: \n${JSON.stringify({
            stateBucketName: command.stateBucketName,
            stateObject: command.stateObject,
            profile: command.profile,
            color: command.color,
            verbose: command.verbose,
            printStack: command.printStack,
        }, undefined, 2)}`);

        this.loadRuntimeConfiguration(command);

        if (command.printStack === true) {
            ConsoleUtil.printStacktraces = true;
        }
        if (command.verbose === true) {
            ConsoleUtil.verbose = true;
        }
        if (command.color === false) {
            ConsoleUtil.colorizeLogs = false;
        }

        await AwsUtil.InitializeWithProfile(command.profile);

        if (command.masterAccountId !== undefined) {
            AwsUtil.SetMasterAccountId(command.masterAccountId);
        }

        if (command.debugTemplating) {
            NunjucksDebugSettings.debug = true;
        }

        await AwsUtil.InitializeWithCurrentPartition();

        command.initialized = true;
    }

    private loadRuntimeConfiguration(command: ICommandArgs): void {
        const rc = RC('org-formation', {}, {}) as IRCObject;
        if (rc.configs !== undefined) {

            if (rc.organizationFile && rc.config && !rc.organizationFile.startsWith('s3://')) {
                const dir = path.dirname(rc.config);
                const absolutePath = path.join(dir, rc.organizationFile);
                if (absolutePath !== rc.organizationFile) {
                    ConsoleUtil.LogDebug(`organization file from runtime configuration resolved to absolute file path: ${absolutePath} (${rc.config} + ${rc.organizationFile})`);
                    rc.organizationFile = absolutePath;
                }
            }

            if (rc.templatingContext && rc.config) {
                const dir = path.dirname(rc.config);
                const absolutePath = path.join(dir, rc.templatingContext);
                if (absolutePath !== rc.templatingContext) {
                    ConsoleUtil.LogDebug(`templating context file from runtime configuration resolved to absolute file path: ${absolutePath} (${rc.config} + ${rc.templatingContext})`);
                    rc.templatingContext = absolutePath;
                }
            }

            if (rc.printStacksOutputPath && rc.config) {
                const dir = path.dirname(rc.config);
                const absolutePath = path.join(dir, rc.printStacksOutputPath);
                if (absolutePath !== rc.printStacksOutputPath) {
                    ConsoleUtil.LogDebug(`print-stacks output path from runtime configuration resolved to absolute file path: ${absolutePath} (${rc.config} + ${rc.printStacksOutputPath})`);
                    rc.printStacksOutputPath = absolutePath;
                }
            }

            ConsoleUtil.LogDebug(`runtime configuration: \n${JSON.stringify(rc)}`);
            Validator.validateRC(rc);

            if (process.argv.indexOf('--state-bucket-name') === -1 && rc.stateBucketName !== undefined) {
                command.stateBucketName = rc.stateBucketName;
            }

            if (process.argv.indexOf('--state-object') === -1 && rc.stateObject !== undefined) {
                command.stateObject = rc.stateObject;
            }

            if (process.argv.indexOf('--profile') === -1 && rc.profile !== undefined) {
                command.profile = rc.profile;
            }

            if (process.argv.indexOf('--organization-file') === -1 && rc.organizationFile !== undefined) {
                (command as IPerformTasksCommandArgs).organizationFile = rc.organizationFile;
            }

            if (process.argv.indexOf('--templating-context') === -1 && rc.templatingContext !== undefined) {
                (command as IPerformTasksCommandArgs).TemplatingContext = JSON.parse(readFileSync(rc.templatingContext).toString());
            }

            if (process.argv.indexOf('--output-path') === -1 && rc.printStacksOutputPath !== undefined) {
                (command as IPrintTasksCommandArgs).outputPath = rc.printStacksOutputPath;
            }

            if (process.argv.indexOf('--master-account-id') === -1 && rc.masterAccountId !== undefined) {
                (command as IPerformTasksCommandArgs).masterAccountId = rc.masterAccountId;
            }

            if (process.argv.indexOf('--organization-state-object') === -1 && rc.organizationStateObject !== undefined) {
                (command as IPerformTasksCommandArgs).organizationStateObject = rc.organizationStateObject;
            }

            if (process.argv.indexOf('--organization-state-bucket-name') === -1 && rc.organizationStateBucketName !== undefined) {
                (command as IPerformTasksCommandArgs).organizationStateBucketName = rc.organizationStateBucketName;
            }

            if (process.argv.indexOf('--debug-templating') === -1 && rc.debugTemplating !== undefined) {
                (command as IPerformTasksCommandArgs).debugTemplating = rc.debugTemplating;
            }
        }

    }
}

export interface ICommandArgs {
    masterAccountId?: string;
    stateBucketName: string;
    stateObject: string;
    organizationStateObject?: string;
    organizationStateBucketName?: string;
    profile?: string;
    state?: PersistedState;
    debugTemplating?: boolean;
    initialized?: boolean;
    printStack?: boolean;
    verbose?: boolean;
    color?: boolean;
    resolver?: CfnExpressionResolver;
}

export interface IRCObject {
    printStacksOutputPath?: string;
    organizationFile?: string;
    templatingContext?: string;
    masterAccountId?: string;
    stateBucketName?: string;
    stateObject?: string;
    organizationStateObject?: string;
    organizationStateBucketName?: string;
    debugTemplating?: boolean;
    profile?: string;
    configs: string[];
    config: string;
}
