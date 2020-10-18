import path from 'path';
import { writeFileSync } from 'fs';
import { mkdirSync } from 'fs';
import { Command } from 'commander';
import { ConsoleUtil } from '../util/console-util';
import { OrgFormationError } from '../org-formation-error';
import { BaseCliCommand, ICommandArgs } from './base-command';
import { UpdateStacksCommand, IUpdateStacksCommandArgs } from './update-stacks';
import { CloudFormationBinder } from '~cfn-binder/cfn-binder';
import { GlobalState } from '~util/global-state';

const commandName = 'print-stacks <templateFile>';
const commandDescription = 'outputs cloudformation templates generated by org-formation to the console';

export class PrintStacksCommand extends BaseCliCommand<IPrintStacksCommandArgs> {

    public static async Perform(command: IPrintStacksCommandArgs): Promise<void> {
        const x = new PrintStacksCommand();
        await x.performCommand(command);
    }


    constructor(command?: Command) {
        super(command, commandName, commandDescription, 'templateFile');
    }

    public addOptions(command: Command): void {
        command.option('--parameters [parameters]', 'parameter values passed to CloudFormation when executing stacks');
        command.option('--stack-name <stack-name>', 'name of the stack that will be used in CloudFormation', 'print');
        command.option('--organization-file [organization-file]', 'organization file used for organization bindings');
        command.option('--output-path [output-path]', 'path, within the root directory, used to store printed templates', undefined);
        command.option('--output <output>', 'the serialization format used when printing stacks. Either json or yaml.', 'yaml');
        command.option('--output-cross-account-exports <output-path>', 'when set, output well generate cross account exports as part of cfn parameter', false);
        super.addOptions(command);
    }

    public async performCommand(command: IPrintStacksCommandArgs): Promise<void> {
        if (!command.stackName) {
            throw new OrgFormationError('argument --stack-name is missing');
        }

        const template = UpdateStacksCommand.createTemplateUsingOverrides(command as IUpdateStacksCommandArgs, command.templateFile);
        const state = await this.getState(command);
        GlobalState.Init(state, template);

        const cfnBinder = new CloudFormationBinder(command.stackName, template, state);

        const bindings = cfnBinder.enumBindings();
        for (const binding of bindings) {
            if (binding.action === 'Delete') {
                ConsoleUtil.LogInfo(`stack ${command.stackName} for account ${binding.accountId} and region ${binding.region} will be deleted`);
                continue;
            }

            const templateBody = binding.template.createTemplateBody({ outputCrossAccountExports: command.outputCrossAccountExports, output: command.output });

            if (command.outputPath !== undefined)  {
                const outputPath = path.resolve(command.outputPath, command.stackName);

                const fileName = toKebabCase(`${binding.region}-${binding.accountLogicalId}`) + '.' + command.output;
                const resolvedPath = path.resolve(outputPath, fileName);

                try{
                    mkdirSync(outputPath, { recursive: true });
                    writeFileSync(resolvedPath, templateBody, { });
                }catch(err) {
                    ConsoleUtil.LogError('error writing template to file', err);
                    throw new OrgFormationError('error writing file');
                }
            }
            else {
                ConsoleUtil.Out(`template for account ${binding.accountId} and region ${binding.region}`);
                ConsoleUtil.Out(templateBody);
            }
        }
    }
}

const toKebabCase = (input: string): string => {
    if (input !== undefined) {
        return input.match(/[A-Z]{2,}(?=[A-Z][a-z]+[0-9]*|\b)|[A-Z]?[a-z]+[0-9]*|[A-Z]|[0-9]+/g).map(x=>x.toLowerCase()).join('-');
    }
    return undefined;
};

export interface IPrintStacksCommandArgs extends ICommandArgs {
    templateFile: string;
    stackName: string;
    organizationFile?: string;
    outputPath?: string;
    outputCrossAccountExports?: boolean;
    output?: 'json' | 'yaml';
}
