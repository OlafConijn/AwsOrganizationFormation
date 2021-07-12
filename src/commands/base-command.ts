import path from 'path';
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
        const govCloudCredentials = await AwsUtil.GetGovCloudCredentials();
        let awsReader: AwsOrganizationReader;
        if (govCloudCredentials) {
            awsReader = new AwsOrganizationReader(organizations, null, govCloudCredentials);
        } else {
            awsReader = new AwsOrganizationReader(organizations);
        }
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
        /**
         * Note the addition of two commands here. The gov-cloud-profile is used to know which profile to grab from your config file.
         * The gov-cloud boolean is used to denote when you're running org-formation with the primary profile as govcloud. This is used
         * so that org-formation knows to use resources with a govcloud region, but this might be able to be simplified by just
         * updating the AWS.config.region.
         */
        command.option('--state-bucket-name [state-bucket-name]', 'bucket name that contains state file', 'organization-formation-${AWS::AccountId}');
        command.option('--state-object [state-object]', 'key for object used to store state', DEFAULT_STATE_OBJECT);
        command.option('--profile [profile]', 'aws profile to use');
        command.option('--print-stack', 'will print stack traces for errors');
        command.option('--verbose', 'will enable debug logging');
        command.option('--no-color', 'will disable colorization of console logs');
        command.option('--master-account-id [master-account-id]', 'run org-formation on a build account that functions as a delegated master account');
        command.option('--gov-cloud', 'is run on gov cloud');
        command.option('--gov-cloud-credentials', 'is running on both partitions');
        command.option('--gov-cloud-profile [profile]', 'aws govcloud profile to use');

    }

    protected async getOrganizationBinder(template: TemplateRoot, state: PersistedState): Promise<OrganizationBinder> {
        let roleInMasterAccount: string;
        if (template.organizationSection.masterAccount) {
            roleInMasterAccount = template.organizationSection.masterAccount.buildAccessRoleName;
        }
        const masterAccountId = await AwsUtil.GetMasterAccountId();
        const organizations = await AwsUtil.GetOrganizationsService(masterAccountId, roleInMasterAccount);
        const govCloudCredentials = await AwsUtil.GetGovCloudCredentials();
        const crossAccountConfig = { masterAccountId, masterAccountRoleName: roleInMasterAccount };
        let awsReader: AwsOrganizationReader;
        if (govCloudCredentials) {
            awsReader = new AwsOrganizationReader(organizations, crossAccountConfig, govCloudCredentials);
        } else {
            awsReader = new AwsOrganizationReader(organizations, crossAccountConfig);
        }
        const awsOrganization = new AwsOrganization(awsReader);
        await awsOrganization.initialize();
        let awsWriter: AwsOrganizationWriter;

        if (govCloudCredentials) {
            awsWriter = new AwsOrganizationWriter(organizations, awsOrganization, crossAccountConfig, govCloudCredentials);
        } else {
            awsWriter = new AwsOrganizationWriter(organizations, awsOrganization, crossAccountConfig);
        }
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
        let storageProvider;
        if (command.govCloud) {
            storageProvider = S3StorageProvider.Create(stateBucketName, objectKey, credentials, 'us-gov-west-1');
        } else {
            storageProvider = S3StorageProvider.Create(stateBucketName, objectKey, credentials);
        }
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

        await AwsUtil.InitializeWithProfile(command.profile, command.govCloud);

        if (command.masterAccountId !== undefined) {
            AwsUtil.SetMasterAccountId(command.masterAccountId);
        }

        if (command.govCloudProfile !== undefined) {
            AwsUtil.SetGovCloudProfile(command.govCloudProfile);
            await AwsUtil.SetGovCloudCredentials(command.govCloudProfile);
        }

        if (command.govCloud) {
            AwsUtil.SetIsGovCloud(true);
        }

        if (command.govCloudCredentials) {
            await AwsUtil.SetGovCloudCredentials();
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

            if (process.argv.indexOf('--gov-cloud-profile') === -1 && rc.govCloudProfile !== undefined) {
                command.govCloudProfile = rc.govCloudProfile;
            }

            if (process.argv.indexOf('--organization-file') === -1 && rc.organizationFile !== undefined) {
                (command as IPerformTasksCommandArgs).organizationFile = rc.organizationFile;
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
    govCloudProfile?: string;
    state?: PersistedState;
    initialized?: boolean;
    printStack?: boolean;
    verbose?: boolean;
    color?: boolean;
    govCloud?: boolean;
    govCloudCredentials?: boolean;
    resolver?: CfnExpressionResolver;
}

export interface IRCObject {
    printStacksOutputPath?: string;
    organizationFile?: string;
    masterAccountId?: string;
    stateBucketName?: string;
    stateObject?: string;
    organizationStateObject?: string;
    organizationStateBucketName?: string;
    profile?: string;
    govCloudProfile?: string;
    configs: string[];
    config: string;
}
