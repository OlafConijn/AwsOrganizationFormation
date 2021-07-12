import { readFileSync } from 'fs';
import path from 'path';
import md5 from 'md5';
import { S3 } from 'aws-sdk';
import { OrgFormationError } from '../org-formation-error';
import { BuildTaskProvider } from './build-task-provider';
import { IUpdateOrganizationTaskConfiguration } from './tasks/organization-task';
import { IUpdateStacksBuildTask } from './tasks/update-stacks-task';
import { IPerformTasksCommandArgs } from '~commands/index';
import { CfnExpressionResolver } from '~core/cfn-expression-resolver';
import { CfnMappingsSection } from '~core/cfn-functions/cfn-find-in-map';
import { yamlParseWithIncludes } from '~yaml-cfn/yaml-parse-includes';
import { ConsoleUtil } from '~util/console-util';
import { IOrganizationBinding, TemplateRoot } from '~parser/parser';
import { nunjucksParseWithIncludes } from '~yaml-cfn/nunjucks-parse-includes';
import { nunjucksRender } from '~yaml-cfn/index';
import { AwsUtil } from '~util/aws-util';

export class BuildConfiguration {
    public tasks: IBuildTaskConfiguration[];
    public parameters: Record<string, IBuildFileParameter>;
    public mappings: CfnMappingsSection;
    private file: string;
    private resolver: CfnExpressionResolver;
    private organizationBindings: Record<string, IOrganizationBinding>;

    constructor(input: string, private readonly parameterValues: Record<string, string> = {}, private templatingContext: {} = undefined) {
        this.file = input;
        this.resolver = new CfnExpressionResolver();
        this.tasks = this.enumBuildConfiguration(this.file, templatingContext);
    }

    public enumValidationTasks(command: IPerformTasksCommandArgs): IBuildTask[] {
        const result: IBuildTask[] = [];
        for (const taskConfig of this.tasks) {
            const task = BuildTaskProvider.createValidationTask(taskConfig, command, this.resolver);
            if (task !== undefined) {
                result.push(task);
            }
        }

        this.validateTasksFile(result);

        return result;
    }

    public enumPrintTasks(command: IPerformTasksCommandArgs): IBuildTask[] {
        const result: IBuildTask[] = [];
        for (const taskConfig of this.tasks) {
            const task = BuildTaskProvider.createPrintTask(taskConfig, command, this.resolver);
            if (task !== undefined) {
                result.push(task);
            }
        }

        return result;
    }

    public enumBuildTasks(command: IPerformTasksCommandArgs): IBuildTask[] {
        const result: IBuildTask[] = [];

        for (const taskConfig of this.tasks) {
            const task = BuildTaskProvider.createBuildTask(taskConfig, command, this.resolver);
            result.push(task);
        }

        this.validateTasksFile(result);

        return result;
    }

    private validateTasksFile(tasks: IBuildTask[]): void {
        const updateStackTasks = BuildTaskProvider.recursivelyFilter(tasks, x => x.type === 'update-stacks') as IUpdateStacksBuildTask[];
        const stackNames = updateStackTasks.map(x => x.StackName);
        this.throwForDuplicateVal(stackNames, x => new OrgFormationError(`found more than 1 update-stacks with stackName ${x}.`));

        const updateOrgTasks = BuildTaskProvider.recursivelyFilter(tasks, x => x.type === 'update-organization');
        if (updateOrgTasks.length > 1) {
            throw new OrgFormationError('multiple update-organization tasks found');
        }
    }

    public async fixateOrganizationFile(command: IPerformTasksCommandArgs): Promise<TemplateRoot> {

        if (command.organizationFile === undefined) {
            const updateOrgTasks = this.tasks.filter(x => x.Type === 'update-organization');
            if (updateOrgTasks.length === 0) {
                throw new OrgFormationError('tasks file does not contain a task with type update-organization and no --organization-file was provided on the cli.');
            }
            if (updateOrgTasks.length > 1) {
                throw new OrgFormationError('tasks file has multiple tasks with type update-organization');
            }
            const updateOrgTask = updateOrgTasks[0] as IUpdateOrganizationTaskConfiguration;
            if (updateOrgTask.Template === undefined) {
                throw new OrgFormationError('update-organization task does not contain required Template attribute');
            }

            const dir = path.dirname(this.file);
            command.organizationFile = path.resolve(dir, updateOrgTask.Template);
            command.TemplatingContext = updateOrgTask.TemplatingContext;
        }

        const organizationFileContents = await this.readOrganizationFileContents(command.organizationFile, command.TemplatingContext);
        const pathDirname = path.dirname(command.organizationFile);
        const pathFile = path.basename(command.organizationFile);
        const templateRoot = TemplateRoot.createFromContents(organizationFileContents, pathDirname, pathFile, {}, command.organizationFileHash);

        if (templateRoot.source) {
            command.organizationFileContents = templateRoot.source;
            command.organizationFileHash = md5(organizationFileContents);
        }

        this.resolver.setTemplateRoot(templateRoot);

        return templateRoot;
    }

    private async readOrganizationFileContents(organizationFileLocation: string, textTemplatingContext?: any): Promise<string> {
        try {
            if (organizationFileLocation.startsWith('s3://')) {
                if (textTemplatingContext) { throw new Error('Text templating context is not supported on s3 hosted organization files'); }
                const s3client = new S3(); // we don't know which role to assume yet....
                const bucketAndKey = organizationFileLocation.substring(5);
                const bucketAndKeySplit = bucketAndKey.split('/');
                const response = await s3client.getObject({ Bucket: bucketAndKeySplit[0], Key: bucketAndKeySplit[1] }).promise();
                return response.Body.toString();
            } else {
                const contents = readFileSync(organizationFileLocation).toString();
                if (textTemplatingContext !== undefined) {
                    const filename = path.basename(organizationFileLocation);
                    return nunjucksRender(contents, filename, textTemplatingContext);
                }
                return contents;
            }
        } catch (err) {
            ConsoleUtil.LogError(`unable to load organization file from ${organizationFileLocation}.`, err);
            throw err;
        }
    }

    public enumBuildConfiguration(filePath: string, templatingContext: {}): IBuildTaskConfiguration[] {
        const buildFile = this.loadBuildFile(filePath, templatingContext);
        if (buildFile.AWSTemplateFormatVersion !== undefined) {
            throw new OrgFormationError(`Error loading tasks file ${filePath}, seems like you are loading a template where a tasks file was expected...`);
        }
        return this.enumBuildConfigurationFromBuildFile(filePath, buildFile);
    }

    public loadBuildFile(filePath: string, templatingContext: {}): IBuildFile {
        if (templatingContext) {
            const templatedBuildFile = nunjucksParseWithIncludes(filePath, templatingContext) as IBuildFile;
            return templatedBuildFile ?? {};
        }
        const buildFile = yamlParseWithIncludes(filePath) as IBuildFile;
        return buildFile ?? {};
    }
    public enumBuildConfigurationFromBuildFile(filePath: string, buildFile: IBuildFile): IBuildTaskConfiguration[] {
        this.parameters = buildFile.Parameters;
        this.mappings = buildFile.Mappings;
        this.organizationBindings = buildFile.OrganizationBindings ?? {};

        delete buildFile.Parameters;
        delete buildFile.Mappings;
        delete buildFile.OrganizationBindings;

        if (buildFile.Definitions && (buildFile.Definitions as any).Type) {
            throw new OrgFormationError('Tasks file should not have a task called `Definitions`. This Definitions attribute is reserved for yaml anchors. Did Definitions somehow declare a Type attribute? use an array within your Definitions to declare yaml anchors.');
        }

        delete buildFile.Definitions;

        if (buildFile.Definitions && (buildFile.Definitions as any).Type) {
            throw new OrgFormationError('Tasks file should not have a task called `Definitions`. This Definitions attribute is reserved for yaml anchors. Did Definitions somehow declare a Type attribute? use an array within your Definitions to declare yaml anchors.');
        }

        delete buildFile.Definitions;

        const parametersSection = this.resolver.resolveFirstPass(this.parameters);

        for (const paramName in parametersSection) {
            const param = parametersSection[paramName];
            const paramType = param.Type;

            if (paramType === undefined) {
                throw new OrgFormationError(`expected Type on parameter ${paramName} declared in tasks file ${filePath}`);
            }

            const supportedParamTypes = ['String', 'Number', 'Boolean', 'List<String>'];
            if (!supportedParamTypes.includes(paramType)) {
                throw new OrgFormationError(`unsupported Type on parameter ${paramName} expected one of ${supportedParamTypes.join(', ')}, found: ${paramType}`);
            }

            let value: any = this.parameterValues[paramName];
            if (value === undefined) {
                value = param.Default;
            }

            if (value === undefined) {
                throw new OrgFormationError(`expected value for parameter ${paramName} declared in tasks file ${filePath}`);
            }

            if (paramType === 'Boolean') {
                if (value === 'true' || value === 1 || value === true) {
                    value = true;
                } else if (value === 'false' || value === 0 || value === false) {
                    value = false;
                } else {
                    throw new OrgFormationError(`unable to convert value for parameter ${paramName} to boolean. Expected: 'true', 'false', 0 or 1. received ${value}`);
                }
            }

            if (paramType === 'Number') {
                value = parseInt(value, 10);
            }

            this.resolver.addParameter(paramName, value);
        }
        for (const [key, binding] of Object.entries(this.organizationBindings)) {
            if (this.parameters[key]) {
                throw new OrgFormationError(`Cannot declare a parameter and organization binding with the same name ${key}.`);
            }
            this.resolver.addBinding(key, binding);
        }
        this.resolver.addMappings(this.mappings);
        this.resolver.setFilePath(filePath);
        this.resolver.addParameter('AWS::Partition', AwsUtil.partition);
        const resolvedContents = this.resolver.resolveFirstPass(buildFile);

        const result: IBuildTaskConfiguration[] = [];
        for (const name in resolvedContents) {
            const config = resolvedContents[name] as IBuildTaskConfiguration;
            result.push({ ...config, LogicalName: name, FilePath: filePath });
        }

        for (const task of result) {
            if (task.DependsOn === undefined) { continue; }

            let dependencies = task.DependsOn;
            if (!Array.isArray(dependencies)) {
                dependencies = [dependencies];
            }

            for (const dependency of dependencies) {
                if (typeof dependency !== 'string') {
                    ConsoleUtil.LogWarning(`Task ${task.LogicalName} declares DependsOn that is not a string. you must use the name of the task, not !Ref to the task.`);
                } else {
                    const found = result.find(x => x.LogicalName === dependency);
                    if (found === undefined) {
                        ConsoleUtil.LogWarning(`Task ${task.LogicalName} depends on task ${dependency} which was not found.`);
                    }
                }
            }
        }

        return result;

    }

    private throwForDuplicateVal(arr: string[], fnError: (val: string) => Error): void {
        const sortedArr = arr.sort();
        for (let i = 0; i < sortedArr.length - 1; i++) {
            if (sortedArr[i + 1] === sortedArr[i]) {
                const duplicate = sortedArr[i];
                throw fnError(duplicate);
            }
        }
    }
}


export interface IBuildTaskConfiguration {
    Type: string;
    DependsOn?: string | string[];
    LogicalName: string;
    FilePath?: string;
    Skip?: boolean;
    TaskRoleName?: string;
    TaskViaRoleArn?: string;
    ForceDeploy?: boolean;
    LogVerbose?: boolean;
}


export interface IBuildTask {
    name: string;
    type: string;
    skip?: boolean;
    isDependency(task: IBuildTask): boolean;
    childTasks: IBuildTask[];
    perform(): Promise<void>;
    physicalIdForCleanup?: string;
}

export interface IBuildFile extends Record<string, IBuildTaskConfiguration | {}> {
    Parameters?: Record<string, IBuildFileParameter>;
    Mappings?: CfnMappingsSection;
    OrganizationBindings?: Record<string, IOrganizationBinding>;
}

export interface IBuildFileParameter {
    Type: string;
    Default: string | IOrganizationBinding;
}
