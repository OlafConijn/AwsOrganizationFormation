import { Command } from 'commander';
import { ConsoleUtil } from '../util/console-util';
import { BaseCliCommand, ICommandArgs } from './base-command';
import { ChangeSetProvider } from '~change-set/change-set-provider';
import { TemplateRoot } from '~parser/parser';
import { GlobalState } from '~util/global-state';
import { AwsUtil } from '~util/aws-util';

const commandName = 'create-change-set <templateFile>';
const commandDescription = 'create change set that can be reviewed and executed later';

export class CreateChangeSetCommand extends BaseCliCommand<ICreateChangeSetCommandArgs> {

    constructor(command: Command) {
        super(command, commandName, commandDescription, 'templateFile');
    }

    public addOptions(command: Command): void {
        super.addOptions(command);
        command.option('--change-set-name [change-set-name]', 'change set name');
    }

    public async performCommand(command: ICreateChangeSetCommandArgs): Promise<void> {

        const template = await TemplateRoot.create(command.templateFile);
        const state = await this.getState(command);

        GlobalState.Init(state, template);

        const binder = await this.getOrganizationBinder(template, state);

        const stateBucketName = await BaseCliCommand.GetStateBucketName(command.stateBucketName);
        const provider = new ChangeSetProvider(stateBucketName);
        const tasks = binder.enumBuildTasks();

        const changeSet = await provider.createChangeSet(command.changeSetName, template, tasks);

        const isGovCloud = await AwsUtil.GetGovCloudProfile();
        if (isGovCloud) {
            const govProvider = new ChangeSetProvider(stateBucketName, true);
            await govProvider.createChangeSet(command.changeSetName, template, tasks);

        }

        const contents = JSON.stringify(changeSet, null, 2);
        ConsoleUtil.Out(contents);
    }
}

export interface ICreateChangeSetCommandArgs extends ICommandArgs {
    masterAccountId?: any;
    templateFile: string;
    changeSetName?: string;
}
