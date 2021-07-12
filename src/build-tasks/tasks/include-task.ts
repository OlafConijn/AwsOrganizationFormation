import path from 'path';
import { ConsoleUtil } from '../../util/console-util';
import { OrgFormationError } from '../../../src/org-formation-error';
import { IBuildTask, BuildConfiguration, IBuildTaskConfiguration } from '~build-tasks/build-configuration';
import { IPerformTasksCommandArgs } from '~commands/index';
import { BuildRunner } from '~build-tasks/build-runner';
import { IBuildTaskProvider, BuildTaskProvider } from '~build-tasks/build-task-provider';
import { IPrintTasksCommandArgs } from '~commands/print-tasks';
import { CfnExpressionResolver } from '~core/cfn-expression-resolver';


export class IncludeTaskProvider implements IBuildTaskProvider<IIncludeTaskConfiguration> {

    public type = 'include';

    createTask(config: IIncludeTaskConfiguration, command: IPerformTasksCommandArgs, resolver: CfnExpressionResolver): IBuildTask {

        if (config.Path === undefined) {
            throw new OrgFormationError(`Required attribute Path missing for task ${config.LogicalName}`);
        }

        const dir = path.dirname(config.FilePath);
        const taskFilePath = path.join(dir, config.Path);
        const parameters: Record<string, any> = { ...command.parsedParameters, ...(config.Parameters ?? {}) };
        const buildConfig = new BuildConfiguration(taskFilePath, parameters, resolver.resolveTemplatingContext(config.TemplatingContext));

        const commandForInclude: IPerformTasksCommandArgs = {
            ...command,
            logicalNamePrefix: this.createLogicalNamePrefix(command.logicalNamePrefix, config.LogicalName),
            forceDeploy: typeof config.ForceDeploy === 'boolean' ? config.ForceDeploy : command.forceDeploy,
            verbose: typeof config.LogVerbose === 'boolean' ? config.LogVerbose : command.verbose,
        };

        const childTasks = buildConfig.enumBuildTasks(commandForInclude);

        return {
            type: config.Type,
            name: config.LogicalName,
            childTasks,
            skip: typeof config.Skip === 'boolean' ? config.Skip : undefined,
            isDependency: BuildTaskProvider.createIsDependency(config),
            perform: async (): Promise<void> => {
                ConsoleUtil.LogInfo(`Executing: ${config.Type} ${taskFilePath}.`);
                await BuildRunner.RunTasks(childTasks, commandForInclude.verbose === true, config.MaxConcurrentTasks, config.FailedTaskTolerance);
            },
        };
    }

    createTaskForValidation(config: IIncludeTaskConfiguration, command: IPerformTasksCommandArgs, resolver: CfnExpressionResolver): IBuildTask | undefined {

        if (config.Path === undefined) {
            throw new OrgFormationError(`Required attribute Path missing for task ${config.LogicalName}`);
        }

        const dir = path.dirname(config.FilePath);
        const taskFilePath = path.join(dir, config.Path);
        const parameters: Record<string, any> = { ...command.parsedParameters, ...(config.Parameters ?? {}) };
        const buildConfig = new BuildConfiguration(taskFilePath, parameters, resolver.resolveTemplatingContext(config.TemplatingContext));

        const commandForInclude: IPerformTasksCommandArgs = {
            ...command,
            logicalNamePrefix: this.createLogicalNamePrefix(command.logicalNamePrefix, config.LogicalName),
            verbose: typeof config.LogVerbose === 'boolean' ? config.LogVerbose : command.verbose,
        };

        const childTasks = buildConfig.enumValidationTasks(commandForInclude);

        return {
            type: config.Type,
            name: config.LogicalName,
            skip: typeof config.Skip === 'boolean' ? config.Skip : undefined,
            childTasks,
            isDependency: BuildTaskProvider.createIsDependency(config),
            perform: async (): Promise<void> => await BuildRunner.RunValidationTasks(childTasks, commandForInclude.verbose === true, config.MaxConcurrentTasks, config.FailedTaskTolerance),
        };
    }

    createTaskForPrint(config: IIncludeTaskConfiguration, command: IPrintTasksCommandArgs, resolver: CfnExpressionResolver): IBuildTask {
        if (config.Path === undefined) {
            throw new OrgFormationError(`Required attribute Path missing for task ${config.LogicalName}`);
        }

        const dir = path.dirname(config.FilePath);
        const taskFilePath = path.join(dir, config.Path);
        const parameters: Record<string, any> = { ...command.parsedParameters, ...(config.Parameters ?? {}) };
        const buildConfig = new BuildConfiguration(taskFilePath, parameters, resolver.resolveTemplatingContext(config.TemplatingContext));

        const commandForInclude: IPrintTasksCommandArgs = {
            ...command,
            verbose: typeof config.LogVerbose === 'boolean' ? config.LogVerbose : command.verbose,
        };

        const childTasks = buildConfig.enumPrintTasks(commandForInclude);

        return {
            type: config.Type,
            name: config.LogicalName,
            skip: typeof config.Skip === 'boolean' ? config.Skip : undefined,
            childTasks,
            isDependency: BuildTaskProvider.createIsDependency(config),
            perform: async (): Promise<void> => await BuildRunner.RunPrintTasks(childTasks, commandForInclude.verbose === true, config.MaxConcurrentTasks, config.FailedTaskTolerance),
        };
    }

    createTaskForCleanup(): IBuildTask | undefined {
        return undefined;
    }

    createLogicalNamePrefix(logicalNamePrefixOfParent: string | undefined, logicalNameOfParent: string): string {
        return `${logicalNamePrefixOfParent === undefined ? '' : logicalNamePrefixOfParent + '-'}${logicalNameOfParent}`;
    }
}
export interface IIncludeTaskConfiguration extends IBuildTaskConfiguration {
    Path: string;
    Parameters: Record<string, any>;
    MaxConcurrentTasks?: number;
    FailedTaskTolerance?: number;
    ForceDeploy?: boolean;
    LogVerbose?: boolean;
    TemplatingContext?: {};
}
