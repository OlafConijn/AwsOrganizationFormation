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

export class TfBuildTaskPlugin implements IBuildTaskPlugin<ITfBuildTaskConfig, ITfCommandArgs, ITfTask> {

    type = 'tf';
    typeForTask = 'apply-tf';

    convertToCommandArgs(config: ITfBuildTaskConfig, command: IPerformTasksCommandArgs): ITfCommandArgs {

        Validator.ThrowForUnknownAttribute(config, config.LogicalName, ...CommonTaskAttributeNames, 'Path',
            'FailedTaskTolerance', 'MaxConcurrentTasks', 'CustomInitCommand',
            'CustomDeployCommand', 'CustomRemoveCommand', 'Parameters');

        if (!config.Path) {
            throw new OrgFormationError(`task ${config.LogicalName} does not have required attribute Path`);
        }

        const dir = path.dirname(config.FilePath);
        const cdkPath = path.join(dir, config.Path);

        return {
            ...command,
            name: config.LogicalName,
            path: cdkPath,
            failedTolerance: config.FailedTaskTolerance ?? 0,
            maxConcurrent: config.MaxConcurrentTasks ?? 1,
            organizationBinding: config.OrganizationBinding,
            taskRoleName: config.TaskRoleName,
            customDeployCommand: config.CustomDeployCommand,
            customRemoveCommand: config.CustomRemoveCommand,
            parameters: config.Parameters,
        };
    }

    validateCommandArgs(commandArgs: ITfCommandArgs): void {
        if (!commandArgs.organizationBinding) {
            throw new OrgFormationError(`task ${commandArgs.name} does not have required attribute OrganizationBinding`);
        }

        if (commandArgs.maxConcurrent > 1) {
            throw new OrgFormationError(`task ${commandArgs.name} does not support a MaxConcurrentTasks higher than 1`);
        }

        if (!existsSync(commandArgs.path)) {
            throw new OrgFormationError(`task ${commandArgs.name} cannot find path ${commandArgs.path}`);
        }
        Validator.ValidateOrganizationBinding(commandArgs.organizationBinding, commandArgs.name);
    }

    getValuesForEquality(command: ITfCommandArgs): any {
        const hashOfTfDirectory = Md5Util.Md5OfPath(command.path);
        return {
            path: hashOfTfDirectory,
            customInitCommand: command.customInitCommand,
            customDeployCommand: command.customDeployCommand,
            customRemoveCommand: command.customRemoveCommand,
            parameters: command.parameters,
        };
    }

    convertToTask(command: ITfCommandArgs, globalHash: string): ITfTask {
        return {
            type: this.type,
            name: command.name,
            path: command.path,
            hash: globalHash,
            taskRoleName: command.taskRoleName,
            customDeployCommand: command.customDeployCommand,
            customRemoveCommand: command.customRemoveCommand,
            parameters: command.parameters,
            forceDeploy: typeof command.forceDeploy === 'boolean' ? command.forceDeploy : false,
            logVerbose: typeof command.verbose === 'boolean' ? command.verbose : false,
        };
    }

    async performInit(binding: IPluginBinding<ITfTask>): Promise<void> {
        const { task, target } = binding;
        let command: string;
        if (task.customDeployCommand) {
            Validator.throwForUnresolvedExpressions(task.customInitCommand, 'CustomInitCommand');
            command = task.customInitCommand as string;
        } else {
            command = 'terraform init';
        }

        const accountId = target.accountId;
        const cwd = path.resolve(task.path);
        const env = TfBuildTaskPlugin.GetEnvironmentVariables(target);
        await ChildProcessUtility.SpawnProcessForAccount(cwd, command, accountId, task.taskRoleName, env, task.logVerbose);
    }

    async performCreateOrUpdate(binding: IPluginBinding<ITfTask>, resolver: CfnExpressionResolver): Promise<void> {
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
            const commandExpression = { 'Fn::Sub': 'terraform apply ${CurrentTask.Parameters}' } as ICfnSubExpression;
            command = await resolver.resolveSingleExpression(commandExpression, 'CustomDeployCommand');
        }

        const accountId = target.accountId;
        const cwd = path.resolve(task.path);
        const env = TfBuildTaskPlugin.GetEnvironmentVariables(target);
        await this.performInit(binding);
        await ChildProcessUtility.SpawnProcessForAccount(cwd, command, accountId, task.taskRoleName, env, task.logVerbose);
    }

    async performRemove(binding: IPluginBinding<ITfTask>, resolver: CfnExpressionResolver): Promise<void> {
        const { task, target } = binding;
        let command: string;

        if (task.customRemoveCommand) {
            Validator.throwForUnresolvedExpressions(task.customRemoveCommand, 'CustomRemoveCommand');
            command = task.customRemoveCommand as string;
        } else {
            const commandExpression = { 'Fn::Sub': 'terraform destroy ${CurrentTask.Parameters}' } as ICfnSubExpression;
            command = await resolver.resolveSingleExpression(commandExpression, 'CustomRemoveCommand');
        }

        const accountId = target.accountId;
        const cwd = path.resolve(task.path);
        const env = TfBuildTaskPlugin.GetEnvironmentVariables(target);
        await this.performInit(binding);
        await ChildProcessUtility.SpawnProcessForAccount(cwd, command, accountId, task.taskRoleName, env, task.logVerbose);
    }

    async appendResolvers(resolver: CfnExpressionResolver, binding: IPluginBinding<ITfTask>): Promise<void> {
        const { task } = binding;
        const p = await resolver.resolve(task.parameters);
        const collapsed = await resolver.collapse(p);
        const parametersAsString = TfBuildTaskPlugin.GetParametersAsArgument(collapsed);
        resolver.addResourceWithAttributes('CurrentTask', { Parameters: parametersAsString });
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    static GetEnvironmentVariables(_: IGenericTarget<ITfTask>): Record<string, string> {
        return {

        };
    }

    getPhysicalIdForCleanup(): string {
        return undefined;
    }

    static GetParametersAsArgument(parameters: Record<string, any>): string {
        if (!parameters) { return ''; }
        const entries = Object.entries(parameters);
        return entries.reduce((prev, curr) => prev + ` -var "${curr[0]}=${curr[1]}"`, '');
    }
}


interface ITfBuildTaskConfig extends IBuildTaskConfiguration {
    Path: string;
    OrganizationBinding: IOrganizationBinding;
    MaxConcurrentTasks?: number;
    FailedTaskTolerance?: number;
    CustomInitCommand?: string;
    CustomDeployCommand?: string;
    CustomRemoveCommand?: string;
    Parameters?: Record<string, ICfnExpression>;
}

export interface ITfCommandArgs extends IBuildTaskPluginCommandArgs {
    path: string;
    customInitCommand?: string;
    customDeployCommand?: string;
    customRemoveCommand?: string;
    parameters?: Record<string, ICfnExpression>;
}

export interface ITfTask extends IPluginTask {
    path: string;
    customInitCommand?: string;
    customDeployCommand?: ICfnExpression;
    customRemoveCommand?: ICfnExpression;
}
