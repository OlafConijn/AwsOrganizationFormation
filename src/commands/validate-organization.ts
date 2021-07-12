import { Command } from 'commander';
import { ConsoleUtil } from '../util/console-util';
import { BaseCliCommand } from './base-command';
import { IUpdateOrganizationCommandArgs } from './update-organization';
import { IUpdateStacksCommandArgs } from './update-stacks';
import { TemplateRoot } from '~parser/parser';
import { GlobalState } from '~util/global-state';


const commandName = 'validate <templateFile>';
const commandDescription = 'validate organization resources';

export class ValidateOrganizationCommand extends BaseCliCommand<IUpdateOrganizationCommandArgs> {

    static SkipValidationForTasks = false;

    constructor(command?: Command) {
        super(command, commandName, commandDescription, 'templateFile');
    }

    public static async Perform(command: IUpdateOrganizationCommandArgs): Promise<void> {
        const x = new ValidateOrganizationCommand();
        await x.performCommand(command);
    }

    protected async performCommand(command: IUpdateOrganizationCommandArgs): Promise<void> {

        const template = await TemplateRoot.create(command.templateFile, { TemplatingContext: command.templatingContext, OrganizationFileContents: (command as IUpdateStacksCommandArgs).organizationFileContents }, (command as IUpdateStacksCommandArgs).organizationFileHash);
        const state = await this.getState(command);
        const templateHash = template.hash;

        GlobalState.Init(state, template);

        const lastHash = state.getTemplateHash();
        if (command.forceDeploy === true) {
            ConsoleUtil.LogInfo('organization validation forced.');
        } else if (lastHash === templateHash) {
            ConsoleUtil.LogInfo('organization up to date, no work to be done.');
            return;
        }

        const binder = await this.getOrganizationBinder(template, state);

        const tasks = binder.enumBuildTasks();
        const createTasks = tasks.filter(x => x.action === 'Create');
        if (createTasks.length > 0) {
            ConsoleUtil.LogWarning('Accounts were added to the organization model.');
            ConsoleUtil.LogWarning('Tasks might depend on updating the organization.');
            ConsoleUtil.LogWarning('Validation and printing of tasks will be skipped.');
            ValidateOrganizationCommand.SkipValidationForTasks = true;
        }
    }
}
