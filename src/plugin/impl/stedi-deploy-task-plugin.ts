import path from 'path';
import { existsSync } from 'fs';
import { IBuildTaskPlugin, IBuildTaskPluginCommandArgs, CommonTaskAttributeNames } from '../plugin';
import { OrgFormationError } from '../../org-formation-error';
import { ConsoleUtil } from '../../util/console-util';
import { IBuildTaskConfiguration } from '~build-tasks/build-configuration';
import { IPluginBinding, IPluginTask } from '~plugin/plugin-binder';
import { IOrganizationBinding } from '~parser/parser';
import { IPerformTasksCommandArgs } from '~commands/index';
import { Md5Util } from '~util/md5-util';
import { ChildProcessUtility } from '~util/child-process-util';
import { Validator } from '~parser/validator';
import { IGenericTarget } from '~state/persisted-state';
import { ICfnExpression, ICfnSubExpression } from '~core/cfn-expression';
import { CfnExpressionResolver } from '~core/cfn-expression-resolver';

export class StediBuildTaskPlugin implements IBuildTaskPlugin<IStediBuildTaskConfig, IStediCommandArgs, IStediTask> {

    type = 'stedi';
    typeForTask = 'deploy-stedi-resource-set';

    convertToCommandArgs(config: IStediBuildTaskConfig, command: IPerformTasksCommandArgs): IStediCommandArgs {

        Validator.ThrowForUnknownAttribute(config, config.LogicalName, ...CommonTaskAttributeNames, 'Template', 'TemplatingContext',
            'FailedTaskTolerance', 'MaxConcurrentTasks', 'CustomInstallCommand', 'ResourceSetName',
            'CustomDeployCommand', 'CustomRemoveCommand', 'Parameters');

        if (!config.Template) {
            throw new OrgFormationError(`task ${config.LogicalName} does not have required attribute Template`);
        }

        if (!config.ResourceSetName) {
            throw new OrgFormationError(`task ${config.LogicalName} does not have required attribute ResourceSetName`);
        }
        const dir = path.dirname(config.FilePath);
        const resolvedTemplatePath = path.join(dir, config.Template);

        return {
            ...command,
            name: config.LogicalName,
            path: resolvedTemplatePath,
            failedTolerance: config.FailedTaskTolerance ?? 0,
            maxConcurrent: config.MaxConcurrentTasks ?? 1,
            organizationBinding: config.OrganizationBinding,
            taskRoleName: config.TaskRoleName,
            customDeployCommand: config.CustomDeployCommand,
            customRemoveCommand: config.CustomRemoveCommand,
            parameters: config.Parameters,
            resourceSetName: config.ResourceSetName,
            templatingContext: config.TemplatingContext,
        };
    }

    validateCommandArgs(commandArgs: IStediCommandArgs): void {
        if (!commandArgs.organizationBinding) {
            throw new OrgFormationError(`task ${commandArgs.name} does not have required attribute OrganizationBinding`);
        }

        if (commandArgs.maxConcurrent > 1) {
            throw new OrgFormationError(`task ${commandArgs.name} does not support a MaxConcurrentTasks higher than 1`);
        }

        if (!existsSync(commandArgs.path)) {
            throw new OrgFormationError(`task ${commandArgs.name} cannot find template ${commandArgs.path}`);
        }
        Validator.ValidateOrganizationBinding(commandArgs.organizationBinding, commandArgs.name);
    }

    getValuesForEquality(command: IStediCommandArgs): any {
        const dir = path.dirname(command.path);
        const hashOfTemplateDir = Md5Util.Md5OfPath(dir);
        return {
            templateDir: hashOfTemplateDir,
            resourceSetName: command.resourceSetName,
            templatingContext: command.templatingContext,
            customDeployCommand: command.customDeployCommand,
            customRemoveCommand: command.customRemoveCommand,
            parameters: command.parameters,
        };
    }

    convertToTask(command: IStediCommandArgs, globalHash: string): IStediTask {
        return {
            type: this.type,
            templatingContext: command.templatingContext,
            name: command.name,
            path: command.path,
            hash: globalHash,
            taskRoleName: command.taskRoleName,
            customDeployCommand: command.customDeployCommand,
            customRemoveCommand: command.customRemoveCommand,
            resourceSetName: command.resourceSetName,
            parameters: command.parameters,
            forceDeploy: typeof command.forceDeploy === 'boolean' ? command.forceDeploy : false,
            logVerbose: typeof command.verbose === 'boolean' ? command.verbose : false,
        };
    }

    async performCreateOrUpdate(binding: IPluginBinding<IStediTask>, resolver: CfnExpressionResolver): Promise<void> {
        const { task, target, previousBindingLocalHash } = binding;
        if (task.forceDeploy !== true &&
            task.taskLocalHash !== undefined &&
            task.taskLocalHash === previousBindingLocalHash) {

            ConsoleUtil.LogInfo(`Workload (${this.typeForTask}) ${task.name} in ${target.accountId}/${target.region} skipped, task itself did not change. Use ForceTask to force deployment.`);
            return;
        }

        let command: string;

        if (task.customDeployCommand) {
            Validator.throwForUnresolvedExpressions(task.customDeployCommand, 'CustomDeployCommand');
            command = task.customDeployCommand as string;
        } else {
            const commandExpression = { 'Fn::Sub': 'stedi cicd:deploy -n ${CurrentTask.ResourceSetName} ${CurrentTask.Parameters}' } as ICfnSubExpression;
            command = await resolver.resolveSingleExpression(commandExpression, 'CustomDeployCommand');
        }

        const accountId = target.accountId;
        const cwd = path.resolve(task.path);
        const env = StediBuildTaskPlugin.GetEnvironmentVariables(target);
        await ChildProcessUtility.SpawnProcessForAccount(cwd, command, accountId, task.taskRoleName, env, task.logVerbose);
    }

    async performRemove(binding: IPluginBinding<IStediTask>, resolver: CfnExpressionResolver): Promise<void> {
        const { task, target } = binding;
        let command: string;

        if (task.customRemoveCommand) {
            Validator.throwForUnresolvedExpressions(task.customRemoveCommand, 'CustomRemoveCommand');
            command = task.customRemoveCommand as string;
        } else {
            const commandExpression = { 'Fn::Sub': 'stedi cicd:delete -n ${CurrentTask.ResourceSetName}' } as ICfnSubExpression;
            command = await resolver.resolveSingleExpression(commandExpression, 'CustomRemoveCommand');
        }

        const accountId = target.accountId;
        const cwd = path.resolve(task.path);
        const env = StediBuildTaskPlugin.GetEnvironmentVariables(target);

        await ChildProcessUtility.SpawnProcessForAccount(cwd, command, accountId, task.taskRoleName, env, task.logVerbose);
    }

    async appendResolvers(resolver: CfnExpressionResolver, binding: IPluginBinding<IStediTask>): Promise<void> {
        const { task } = binding;
        const p = await resolver.resolve(task.parameters);
        const collapsed = await resolver.collapse(p);
        const parametersAsString = StediBuildTaskPlugin.GetParametersAsArgument(collapsed);
        resolver.addResourceWithAttributes('CurrentTask', { Parameters: parametersAsString, ResourceSetName: task.resourceSetName });
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    static GetEnvironmentVariables(_: IGenericTarget<IStediTask>): Record<string, string> {
        return {

        };
    }

    getPhysicalIdForCleanup(): string {
        return undefined;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    static GetParametersAsArgument(_: Record<string, any>): string {
        return '';
    }
}


interface IStediBuildTaskConfig extends IBuildTaskConfiguration {
    Template: string;
    ResourceSetName: string;
    TemplatingContext?: Record<string, unknown>;
    OrganizationBinding: IOrganizationBinding;
    MaxConcurrentTasks?: number;
    FailedTaskTolerance?: number;
    CustomDeployCommand?: string;
    CustomRemoveCommand?: string;
    Parameters?: Record<string, ICfnExpression>;
}

export interface IStediCommandArgs extends IBuildTaskPluginCommandArgs {
    path: string;
    resourceSetName: string;
    templatingContext?: Record<string, unknown>;
    customDeployCommand?: string;
    customRemoveCommand?: string;
    parameters?: Record<string, ICfnExpression>;
}

export interface IStediTask extends IPluginTask {
    path: string;
    resourceSetName: string;
    templatingContext?: Record<string, unknown>;
    customDeployCommand?: ICfnExpression;
    customRemoveCommand?: ICfnExpression;
}
