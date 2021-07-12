import { exec, ExecException, ExecOptions } from 'child_process';
import { AwsUtil } from './aws-util';
import { ConsoleUtil } from './console-util';
import { GlobalState } from './global-state';
import { ErrorCode, OrgFormationError } from '~org-formation-error';


export class ChildProcessUtility {

    public static async SpawnProcessForAccount(cwd: string, command: string, accountId: string, roleInTargetAccount?: string, env: Record<string, string> = {}, logVerbose: boolean | undefined = undefined): Promise<void> {
        ConsoleUtil.LogInfo(`Executing command: ${command} in account ${accountId}`);

        if (roleInTargetAccount === undefined) {
            roleInTargetAccount = GlobalState.GetCrossAccountRoleName(roleInTargetAccount);
        }

        try {
            const credentials = await AwsUtil.GetCredentials(accountId, roleInTargetAccount);

            const options: ExecOptions = {
                cwd,
                env: { ...process.env, ...env },
                maxBuffer: 1024 * 500,
            };

            if (credentials) {

                options.env = {
                    ...options.env,
                    AWS_ACCESS_KEY_ID: credentials.accessKeyId,
                    AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
                };
                delete env.AWS_PROFILE;
                if (credentials.sessionToken) {
                    options.env.AWS_SESSION_TOKEN = credentials.sessionToken;
                }
            }


            return await this.SpawnProcess(command, options, logVerbose);
        } catch (err) {
            throw new OrgFormationError(`error invoking external command ${command}.\n error: ${err}`, ErrorCode.FailureToRemove);
        }
    };

    public static SpawnProcess(command: string, options: ExecOptions, logVerbose: boolean | undefined = undefined): Promise<void> {
        // options.shell = '/bin/bash';
        return new Promise((resolve, reject) => {
            const childProcess = exec(command, options, (err: ExecException) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve();
            });

            childProcess.stdout.on('data', x => {
                if (typeof x === 'string') {
                    const trimmed = x.trim();
                    if (trimmed.length === 0) { return; }

                    const emptyIfOnlyDots = trimmed.replace(/\./g, '');
                    if (emptyIfOnlyDots.length === 0) { return; }

                    ConsoleUtil.LogDebug(trimmed, logVerbose);
                }
            });

            childProcess.stderr.on('data', x => {
                if (typeof x === 'string') {
                    const trimmed = x.trim();
                    if (trimmed.length === 0) { return; }

                    ConsoleUtil.LogDebug(trimmed, logVerbose);
                }
            });
        });
    };
}
