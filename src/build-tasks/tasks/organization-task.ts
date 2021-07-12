import path from 'path';
import { ConsoleUtil } from '../../util/console-util';
import { IPerformTasksCommandArgs, IUpdateOrganizationCommandArgs, UpdateOrganizationCommand } from '../../commands/index';
import { IBuildTask, IBuildTaskConfiguration } from '~build-tasks/build-configuration';
import { IBuildTaskProvider } from '~build-tasks/build-task-provider';
import { ValidateOrganizationCommand } from '~commands/validate-organization';
import { OrgFormationError } from '~org-formation-error';

export abstract class BaseOrganizationTask implements IBuildTask {
    public name: string;
    public type: string;
    public skip: boolean;
    public forceDeploy: boolean;
    public taskRoleName: string;
    public taskViaRoleArn: string;
    public templatePath: string;
    public templatingContext?: any;
    public childTasks: IBuildTask[] = [];
    protected config: IUpdateOrganizationTaskConfiguration;
    private command: any;

    constructor(config: IUpdateOrganizationTaskConfiguration, command: IPerformTasksCommandArgs) {
        this.name = config.LogicalName;
        this.type = config.Type;
        this.taskRoleName = config.TaskRoleName;
        this.forceDeploy = config.ForceDeploy === true;
        this.templatingContext = config.TemplatingContext ?? command.TemplatingContext;
        this.config = config;
        const dir = path.dirname(config.FilePath);
        this.templatePath = path.join(dir, config.Template);
        this.command = command;
        this.skip = config.Skip === true;
        if (typeof config.TaskRoleName !== 'string' && typeof config.TaskRoleName !== 'undefined') {
            throw new OrgFormationError(`update-organization TaskViaRoleName attribute must be string, found: ${typeof config.TaskRoleName}`);
        }
        if (config.TaskViaRoleArn !== undefined) {
            throw new OrgFormationError('update-organization task does not support TaskViaRoleArn attribute');
        }
    }

    public async perform(): Promise<void> {
        const updateCommand = this.command as IUpdateOrganizationCommandArgs;
        updateCommand.templateFile = this.templatePath;
        updateCommand.forceDeploy = this.forceDeploy;
        updateCommand.taskRoleName = this.taskRoleName;
        updateCommand.templatingContext = this.templatingContext;

        await this.innerPerform(updateCommand);
    }

    public isDependency(): boolean {
        return false;
    }

    protected abstract innerPerform(commandArgs: IUpdateOrganizationCommandArgs): Promise<void>;
}

export class UpdateOrganizationTask extends BaseOrganizationTask {
    protected async innerPerform(commandArgs: IUpdateOrganizationCommandArgs): Promise<void> {
        ConsoleUtil.LogInfo(`Executing: ${this.config.Type} ${this.templatePath}.`);
        await UpdateOrganizationCommand.Perform(commandArgs);
    }
}

export class ValidateOrganizationTask extends BaseOrganizationTask {
    protected async innerPerform(commandArgs: IUpdateOrganizationCommandArgs): Promise<void> {
        ConsoleUtil.LogInfo(`Executing: ${this.config.Type} ${this.templatePath}.`);
        await ValidateOrganizationCommand.Perform(commandArgs);
    }

}
export class UpdateOrganizationTaskProvider implements IBuildTaskProvider<IUpdateOrganizationTaskConfiguration> {
    public type = 'update-organization';

    createTask(config: IUpdateOrganizationTaskConfiguration, command: IPerformTasksCommandArgs): IBuildTask {
        return new UpdateOrganizationTask(config, command);
    }

    createTaskForValidation(config: IUpdateOrganizationTaskConfiguration, command: IPerformTasksCommandArgs): IBuildTask | undefined {
        return new ValidateOrganizationTask(config, command);
    }

    createTaskForPrint(config: IUpdateOrganizationTaskConfiguration, command: IPerformTasksCommandArgs): IBuildTask {
        return new ValidateOrganizationTask(config, command);
    }

    createTaskForCleanup(): IBuildTask | undefined {
        return undefined;
    }
}

export interface IUpdateOrganizationTaskConfiguration extends IBuildTaskConfiguration {
    Template: string;
    TemplatingContext?: {};
}
