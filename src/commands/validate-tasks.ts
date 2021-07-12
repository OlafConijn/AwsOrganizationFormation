import { Command } from 'commander';
import { BaseCliCommand } from './base-command';
import { IPerformTasksCommandArgs } from './perform-tasks';
import { BuildConfiguration } from '~build-tasks/build-configuration';
import { BuildRunner } from '~build-tasks/build-runner';
import { Validator } from '~parser/validator';

const commandName = 'validate-tasks <tasksFile>';
const commandDescription = 'Will validate the tasks file, including configured tasks';

export class ValidateTasksCommand extends BaseCliCommand<IPerformTasksCommandArgs> {

    public static async Perform(command: IPerformTasksCommandArgs): Promise<void> {
        const x = new ValidateTasksCommand();
        await x.performCommand(command);
    }

    constructor(command?: Command) {
        super(command, commandName, commandDescription, 'tasksFile');
    }

    public addOptions(command: Command): void {
        command.option('--max-concurrent-tasks <max-concurrent-tasks>', 'maximum number of tasks to be executed concurrently', 1);
        command.option('--max-concurrent-stacks <max-concurrent-stacks>', 'maximum number of stacks (within a task) to be executed concurrently', 1);
        command.option('--failed-tasks-tolerance <failed-tasks-tolerance>', 'the number of failed tasks after which execution stops', 99);
        command.option('--failed-stacks-tolerance <failed-stacks-tolerance>', 'the number of failed stacks (within a task) after which execution stops', 0);
        command.option('--organization-file [organization-file]', 'organization file used for organization bindings');
        command.option('--parameters [parameters]', 'parameters used when creating build tasks from tasks file');
        command.option('--organization-state-object [organization-state-object]', 'key for object used to load read-only organization state');
        command.option('--organization-state-bucket-name [organization-state-bucket-name]', 'name of the bucket that contains the read-only organization state');
        command.option('--debug-templating [debug-templating]', 'when set to true the output of text templating processes will be stored on disk', false);

        super.addOptions(command);
    }

    public async performCommand(command: IPerformTasksCommandArgs): Promise<void> {
        const tasksFile = command.tasksFile;

        Validator.validatePositiveInteger(command.maxConcurrentStacks, 'maxConcurrentStacks');
        Validator.validatePositiveInteger(command.failedStacksTolerance, 'failedStacksTolerance');
        Validator.validatePositiveInteger(command.maxConcurrentTasks, 'maxConcurrentTasks');
        Validator.validatePositiveInteger(command.failedTasksTolerance, 'failedTasksTolerance');

        command.parsedParameters = this.parseCfnParameters(command.parameters);
        const config = new BuildConfiguration(tasksFile, command.parsedParameters, command.TemplatingContext);

        await config.fixateOrganizationFile(command);
        const validationTasks = config.enumValidationTasks(command);
        await BuildRunner.RunValidationTasks(validationTasks, command.verbose === true, command.maxConcurrentTasks, command.failedTasksTolerance);
    }
}
