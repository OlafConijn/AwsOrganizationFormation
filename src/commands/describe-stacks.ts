import { Command } from 'commander';
import { ConsoleUtil } from '../util/console-util';
import { BaseCliCommand, ICommandArgs } from './base-command';
import { ICfnTarget } from '~state/persisted-state';

const commandName = 'describe-stacks';
const commandDescription = 'list all stacks deployed to accounts using org-formation';

export class DescribeStacksCommand extends BaseCliCommand<IDescribeStackCommandArgs> {

    static async Perform(command: IDescribeStackCommandArgs): Promise<void> {
        const x = new DescribeStacksCommand();
        await x.performCommand(command);
    }

    constructor(command?: Command) {
        super(command, commandName, commandDescription);
    }

    public addOptions(command: Command): void {
        super.addOptions(command);
        command.option('--stack-name [stack-name]', 'output will be limited to stacks of this name');
    }

    public async performCommand(command: IDescribeStackCommandArgs): Promise<void> {
        const stackName = command.stackName;

        const state = await this.getState(command);
        const record: Record<string, ICfnTarget[]> = {};
        for (const stack of state.listStacks()) {
            if (stackName && stack !== command.stackName) {
                continue;
            }
            record[stack] = [];
            for (const target of state.enumTargets(stack)) {
                record[stack].push(target);
            }

        }
        ConsoleUtil.Out(JSON.stringify(record, null, 2));
    }
}

export interface IDescribeStackCommandArgs extends ICommandArgs {
    stackName?: string;
    masterAccountId?: string;
}
