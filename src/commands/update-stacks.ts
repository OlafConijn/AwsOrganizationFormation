import { Command } from 'commander';
import { ConsoleUtil } from '../util/console-util';
import { OrgFormationError } from '../org-formation-error';
import { BaseCliCommand, ICommandArgs } from './base-command';
import { CloudFormationBinder } from '~cfn-binder/cfn-binder';
import { CfnTaskRunner } from '~cfn-binder/cfn-task-runner';
import { IOrganizationBinding, ITemplateOverrides, TemplateRoot } from '~parser/parser';
import { Validator } from '~parser/validator';
import { GlobalState } from '~util/global-state';

const commandName = 'update-stacks <templateFile>';
const commandDescription = 'update CloudFormation resources in accounts';

export class UpdateStacksCommand extends BaseCliCommand<IUpdateStacksCommandArgs> {

    public static async Perform(command: IUpdateStacksCommandArgs): Promise<void> {
        const x = new UpdateStacksCommand();
        await x.performCommand(command);
    }

    public static async createTemplateUsingOverrides(command: IUpdateStacksCommandArgs, templateFile: string): Promise<TemplateRoot> {
        const templateOverrides: ITemplateOverrides = {};

        if (command.stackDescription) {
            templateOverrides.Description = command.stackDescription;
        }
        if (command.defaultOrganizationBinding) {
            templateOverrides.DefaultOrganizationBinding = command.defaultOrganizationBinding;
        }
        if (command.defaultOrganizationBindingRegion) {
            templateOverrides.DefaultOrganizationBindingRegion = command.defaultOrganizationBindingRegion;
        }
        if (command.organizationFile) {
            templateOverrides.OrganizationFile = command.organizationFile;
        }
        if (command.organizationFileContents) {
            templateOverrides.OrganizationFileContents = command.organizationFileContents;
        }
        if (command.organizationBindings) {
            templateOverrides.OrganizationBindings = command.organizationBindings;
        }
        if (command.parameters) {
            templateOverrides.ParameterValues = {};
            for (const [key, val] of Object.entries(command.parameters)) {
                templateOverrides.ParameterValues[key] = val;
            }
        }
        if (command.templatingContext) {
            templateOverrides.TemplatingContext = {};
            for (const [key, val] of Object.entries(command.templatingContext)) {
                templateOverrides.TemplatingContext[key] = val;
            }
        }
        const template = await TemplateRoot.create(templateFile, templateOverrides, command.organizationFileHash);
        return template;
    }

    constructor(command?: Command) {
        super(command, commandName, commandDescription, 'templateFile');
    }

    public addOptions(command: Command): void {
        command.option('--stack-name <stack-name>', 'name of the stack that will be used in CloudFormation');
        command.option('--stack-description [description]', 'description of the stack that will be displayed CloudFormation');
        command.option('--parameters [parameters]', 'parameter values passed to CloudFormation when executing stacks');
        command.option('--termination-protection', 'value that indicates whether stack must have deletion protection');
        command.option('--organization-file [organization-file]', 'organization file used for organization bindings');
        command.option('--update-protection', 'value that indicates whether stack must have a stack policy that prevents updates');
        command.option('--max-concurrent-stacks <max-concurrent-stacks>', 'maximum number of stacks to be executed concurrently', 1);
        command.option('--failed-stacks-tolerance <failed-stacks-tolerance>', 'the number of failed stacks after which execution stops', 0);
        super.addOptions(command);
    }

    public async performCommand(command: IUpdateStacksCommandArgs): Promise<void> {
        if (!command.stackName) {
            throw new OrgFormationError('argument --stack-name is missing');
        }

        Validator.validatePositiveInteger(command.maxConcurrentStacks, 'maxConcurrentStacks');
        Validator.validatePositiveInteger(command.failedStacksTolerance, 'failedStacksTolerance');
        Validator.validateBoolean(command.terminationProtection, 'terminationProtection');
        Validator.validateBoolean(command.updateProtection, 'updateProtection');

        this.storeCommand(command);

        const terminationProtection = command.terminationProtection === true;
        const updateProtection = command.updateProtection;
        const cloudFormationRoleName = command.cloudFormationRoleName;
        const taskRoleName = command.taskRoleName;
        const taskViaRoleArn = command.taskViaRoleArn;
        const stackName = command.stackName;
        const templateFile = command.templateFile;
        let stackPolicy = command.stackPolicy;
        const tags = command.tags;
        if (updateProtection !== undefined) {
            if (stackPolicy !== undefined) {
                throw new OrgFormationError('Cannot specify value for both stackPolicy as well as updateProtection.');
            }
            if (updateProtection === true) {
                stackPolicy = {
                    Statement:
                    {
                        Effect: 'Deny',
                        Action: 'Update:*',
                        Principal: '*',
                        Resource: '*',
                    },
                };
            } else if (updateProtection === false) {
                stackPolicy = {
                    Statement:
                    {
                        Effect: 'Allow',
                        Action: 'Update:*',
                        Principal: '*',
                        Resource: '*',
                    },
                };
            }
        }
        if (stackPolicy === undefined) {
            stackPolicy = {
                Statement:
                {
                    Effect: 'Allow',
                    Action: 'Update:*',
                    Principal: '*',
                    Resource: '*',
                },
            };
        }
        const template = await UpdateStacksCommand.createTemplateUsingOverrides(command, templateFile);
        const parameters = this.parseCfnParameters(command.parameters);
        const state = await this.getState(command);
        GlobalState.Init(state, template);

        const cfnBinder = new CloudFormationBinder(stackName, template, state, parameters, command.forceDeploy === true, command.verbose === true, taskRoleName, terminationProtection, stackPolicy, tags, cloudFormationRoleName, command.resolver, undefined, taskViaRoleArn);

        const cfnTasks = await cfnBinder.enumTasks();
        if (cfnTasks.length === 0) {
            ConsoleUtil.LogInfo(`Stack ${stackName} already up to date.`);
        } else {
            try {
                await CfnTaskRunner.RunTasks(cfnTasks, stackName, command.verbose === true, command.maxConcurrentStacks, command.failedStacksTolerance);
            } finally {
                await state.save();
            }
        }

    }
}

export interface IUpdateStacksCommandArgs extends ICommandArgs {
    organizationFile?: string;
    organizationFileContents?: string;
    organizationFileHash?: string;
    defaultOrganizationBindingRegion?: any;
    defaultOrganizationBinding?: any;
    organizationBindings?: Record<string, IOrganizationBinding>;
    templateFile: string;
    stackName: string;
    stackDescription?: string;
    parameters?: string | {};
    templatingContext?: {};
    terminationProtection?: boolean;
    updateProtection?: boolean;
    forceDeploy?: boolean;
    maxConcurrentStacks: number;
    failedStacksTolerance: number;
    cloudFormationRoleName?: string;
    taskRoleName?: string;
    taskViaRoleArn?: string;
    stackPolicy?: {};
    tags?: {};
}
