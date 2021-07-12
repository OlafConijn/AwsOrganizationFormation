import { Command } from 'commander';
import { ConsoleUtil } from '../util/console-util';
import { BaseCliCommand } from './base-command';
import { IUpdateStacksCommandArgs, UpdateStacksCommand } from './update-stacks';
import { ValidateOrganizationCommand } from './validate-organization';
import { CloudFormationBinder } from '~cfn-binder/cfn-binder';
import { CfnTaskRunner } from '~cfn-binder/cfn-task-runner';
import { CfnValidateTaskProvider } from '~cfn-binder/cfn-validate-task-provider';
import { GlobalState } from '~util/global-state';
import { Validator } from '~parser/validator';

const commandName = 'validate-stacks <templateFile>';
const commandDescription = 'validates the CloudFormation templates that will be generated';

export class ValidateStacksCommand extends BaseCliCommand<IUpdateStacksCommandArgs> {

    public static async Perform(command: IUpdateStacksCommandArgs): Promise<void> {
        const x = new ValidateStacksCommand();
        await x.performCommand(command);
    }
    constructor(command?: Command) {
        super(command, commandName, commandDescription, 'templateFile');
    }

    public addOptions(command: Command): void {
        command.option('--parameters [parameters]', 'parameter values passed to CloudFormation when executing stacks');
        command.option('--organization-file [organization-file]', 'organization file used for organization bindings');
        command.option('--stack-name <stack-name>', 'name of the stack that will be used in CloudFormation', 'validation');
        super.addOptions(command);
    }

    public async performCommand(command: IUpdateStacksCommandArgs): Promise<void> {
        const templateFile = command.templateFile;

        if (ValidateOrganizationCommand.SkipValidationForTasks) {
            return;
        }

        const maxConcurrentStacks = command.maxConcurrentStacks ?? 1;
        const failedStacksTolerance = command.failedStacksTolerance ?? 99;
        Validator.validatePositiveInteger(maxConcurrentStacks, 'maxConcurrentStacks');
        Validator.validatePositiveInteger(failedStacksTolerance, 'failedStacksTolerance');


        const template = await UpdateStacksCommand.createTemplateUsingOverrides(command, templateFile);
        const state = await this.getState(command);
        GlobalState.Init(state, template);
        ConsoleUtil.state = state;
        const parameters = this.parseCfnParameters(command.parameters);
        const stackPolicy = command.stackPolicy;
        const govCloud = command.govCloud === true;
        const cloudFormationRoleName = command.cloudFormationRoleName;
        const taskViaRoleArn = command.taskViaRoleArn;
        const cfnBinder = new CloudFormationBinder(command.stackName, template, state, parameters, false, command.verbose === true, command.taskRoleName, false, stackPolicy, govCloud, cloudFormationRoleName, command.resolver, undefined, taskViaRoleArn);

        const bindings = await cfnBinder.enumBindings();

        const validationTaskProvider = new CfnValidateTaskProvider(template, state, command.verbose === true);
        const tasks = await validationTaskProvider.enumTasks(bindings);
        await CfnTaskRunner.ValidateTemplates(tasks, command.verbose === true, maxConcurrentStacks, failedStacksTolerance);
    }
}
