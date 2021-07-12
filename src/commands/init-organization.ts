import { writeFileSync } from 'fs';
import { Command } from 'commander';
import { ConsoleUtil } from '../util/console-util';
import { AwsUtil } from '../util/aws-util';
import { BaseCliCommand, ICommandArgs } from './base-command';
import { S3StorageProvider } from '~state/storage-provider';
import { DEFAULT_ROLE_FOR_CROSS_ACCOUNT_ACCESS } from '~util/aws-util';

const commandName = 'init <file>';
const commandDescription = 'generate template & initialize organization';

export class InitOrganizationCommand extends BaseCliCommand<IInitCommandArgs> {

    static async Perform(command: IInitCommandArgs): Promise<void> {
        const x = new InitOrganizationCommand();
        await x.performCommand(command);
    }

    constructor(command?: Command) {
        super(command, commandName, commandDescription, 'file');
    }

    public addOptions(command: Command): void {
        command.option('--region <region>', 'region used to created state-bucket in');
        command.option('--cross-account-role-name <cross-account-role-name>', 'name of the role used to perform cross account access', 'OrganizationAccountAccessRole');
        super.addOptions(command);
    }

    public async performCommand(command: IInitCommandArgs): Promise<void> {
        if (command.crossAccountRoleName) {
            DEFAULT_ROLE_FOR_CROSS_ACCOUNT_ACCESS.RoleName = command.crossAccountRoleName;
        }
        this.storeCommand(command);
        let govCloudProvider: S3StorageProvider;
        const filePath = command.file;
        const storageProvider = await this.createOrGetStateBucket(command, command.region);
        const template = await this.generateDefaultTemplate();
        const templateContents = template.template;
        writeFileSync(filePath, templateContents);

        await template.state.save(storageProvider);

        const creds = await AwsUtil.GetGovCloudCredentials();
        if (creds) {
            const masterAccountId = await AwsUtil.GetGovCloudMasterAccountId();
            govCloudProvider = await this.createOrGetStateBucket(command, 'us-gov-west-1', masterAccountId, creds);
            await template.state.save(govCloudProvider, true);
        }

        ConsoleUtil.LogInfo(`Your organization template is written to ${command.file}`);
        ConsoleUtil.LogInfo('Hope this will get you started!');
        ConsoleUtil.LogInfo('');
        ConsoleUtil.LogInfo(`You can keep the ${command.file} file on disk or even better, under source control.`);
        ConsoleUtil.LogInfo('If you work with code pipeline you might find init-pipeline an interesting command too.');
        ConsoleUtil.LogInfo('');
        ConsoleUtil.LogInfo(`Don't worry about losing the ${command.file} file, at any point you can recreate it.`);
        ConsoleUtil.LogInfo('Have fun! ');
        ConsoleUtil.LogInfo('');
        ConsoleUtil.LogInfo('--OC');

    }
}

export interface IInitCommandArgs extends ICommandArgs {
    file: string;
    region: string;
    crossAccountRoleName: string;
}
