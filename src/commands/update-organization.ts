import { Command } from 'commander';
import { ConsoleUtil } from '../util/console-util';
import { AwsUtil } from '../util/aws-util';

import { BaseCliCommand, ICommandArgs } from './base-command';
import { TaskRunner } from '~org-binder/org-task-runner';
import { TemplateRoot } from '~parser/parser';
import { PersistedState } from '~state/persisted-state';
import { IBuildTask } from '~org-binder/org-tasks-provider';
import { GlobalState } from '~util/global-state';
import { S3StorageProvider } from '~state/storage-provider';


const commandName = 'update <templateFile>';
const commandDescription = 'update organization resources';

export class UpdateOrganizationCommand extends BaseCliCommand<IUpdateOrganizationCommandArgs> {

    public static async Perform(command: IUpdateOrganizationCommandArgs): Promise<void> {
        const x = new UpdateOrganizationCommand();
        await x.performCommand(command);
    }

    static HasRan: boolean;

    static ResetHasRan(): void {
        this.HasRan = false;
    }

    constructor(command?: Command) {
        super(command, commandName, commandDescription, 'templateFile');
    }

    public addOptions(command: Command): void {
        super.addOptions(command);
    }

    public async performCommand(command: IUpdateOrganizationCommandArgs): Promise<void> {
        const template = await TemplateRoot.create(command.templateFile);
        const state = await this.getState(command);
        let govCloudProvider: S3StorageProvider;

        /**
         * These additional providers and such are all over the place, since I added them as I went along.
         * Would be great if we could centralize the govcloud provider stuff.
         */
         const creds = await AwsUtil.GetGovCloudCredentials();
         if (creds) {
            const masterAccountId = await AwsUtil.GetGovCloudMasterAccountId();
            govCloudProvider = await this.createOrGetStateBucket(command, 'us-gov-west-1', masterAccountId, creds);
        }

        GlobalState.Init(state, template);

        const templateHash = template.hash;

        UpdateOrganizationCommand.HasRan = true;

        const lastHash = state.getTemplateHash();
        if (command.forceDeploy === true) {
            ConsoleUtil.LogInfo('organization update forced.');
        } else if (lastHash === templateHash) {
            ConsoleUtil.LogInfo('organization up to date, no work to be done.');
            return;
        }

        const binder = await this.getOrganizationBinder(template, state);
        const tasks = binder.enumBuildTasks();
        await UpdateOrganizationCommand.ExecuteTasks(tasks, state, templateHash, template, govCloudProvider);
    }

    public static async ExecuteTasks(tasks: IBuildTask[], state: PersistedState, templateHash: string, template: TemplateRoot, govCloudProvider?: S3StorageProvider): Promise<void> {
        try {
            if (tasks.length === 0) {
                ConsoleUtil.LogInfo('organization up to date, no work to be done.');
            } else {
                await TaskRunner.RunTasks(tasks);
                ConsoleUtil.LogInfo('done');
            }
            state.putTemplateHash(templateHash);
            state.setPreviousTemplate(template.source);
        }
        finally {
            await state.save();

            if (govCloudProvider !== undefined) {
                await state.save(govCloudProvider, true);
            }

        }
    }
}

export interface IUpdateOrganizationCommandArgs extends ICommandArgs {
    templateFile: string;
    forceDeploy?: boolean;
    taskRoleName?: string;
}
