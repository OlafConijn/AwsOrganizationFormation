import { OrgFormationError } from '../org-formation-error';
import { ConsoleUtil } from '../util/console-util';
import { IStorageProvider, S3StorageProvider } from './storage-provider';
import { OrgResourceTypes } from '~parser/model';

export class PersistedState {
    public static async Load(provider: IStorageProvider, masterAccountId: string): Promise<PersistedState> {
        try {
            const contents = await provider.get();
            let object = {} as IState;
            if (contents && contents.trim().length > 0) {
                object = JSON.parse(contents);
            }
            if (object.stacks === undefined) {
                object.stacks = {};
            }
            if (object.bindings === undefined) {
                object.bindings = {};
            }
            if (object.masterAccountId === undefined) {
                object.masterAccountId = masterAccountId;
            }
            /**
             * Obviously this needs to not be commented out, but since the govcloud master is different from the commercial,
             * it's the only way to run update-stacks in govcloud at the moment.
             */
            // else if (object.masterAccountId !== masterAccountId) {
            //     throw new OrgFormationError('state and session do not belong to the same organization');
            // }
            return new PersistedState(object, provider);
        } catch (err) {
            if (err instanceof SyntaxError) {
                throw new OrgFormationError(`unable to parse state file ${err}`);
            }
            if (provider instanceof S3StorageProvider) {
                throw new OrgFormationError(`unable to load state, bucket: ${provider.bucketName}, key: ${provider.objectKey}. Err: ${err}`);
            }
            throw err;
        }
    }

    public static CreateEmpty(masterAccountId: string): PersistedState {
        const empty = new PersistedState({
            masterAccountId,
            bindings: {},
            stacks: {},
            values: {},
            previousTemplate: '',
            trackedTasks: {},
        });
        empty.dirty = true;

        return empty;
    }

    public readonly masterAccount: string;
    private provider?: IStorageProvider;
    private state: IState;
    private dirty = false;
    private organizationState: PersistedState;
    private readonly = false;
    private organizationLevelState = true;

    constructor(state: IState, provider?: IStorageProvider) {
        this.provider = provider;
        this.state = state;
        this.masterAccount = state.masterAccountId;
        this.organizationState = this;
    }


    public setReadonlyOrganizationState(organizationState: PersistedState): void {
        this.organizationState = organizationState;
        this.organizationState.readonly = true;
        this.organizationState.organizationLevelState = true;

        this.organizationLevelState = false;
    }

    public putTemplateHash(val: string): void {
        if (!this.organizationLevelState) {return;}
       this.putValue('organization.template.hash', val);
    }

    public getTemplateHash(): string {
        return this.organizationState.getValue('organization.template.hash');
    }

    public putTemplateHashLastPublished(val: string): void {
        if (!this.organizationLevelState) {return;}
        this.organizationState.putValue('organization.template-last-published.hash', val);
    }

    public getTemplateHashLastPublished(): string {
        return this.organizationState.getValue('organization.template-last-published.hash');
    }

    public putValue(key: string, val: string): void {
        if (this.readonly) {
            throw new OrgFormationError('attempt to modify to read-only organization level state');
        }
        if (this.state.values === undefined) {
            this.state.values = {};
        }
        this.state.values[key] = val;
        this.dirty = true;
    }

    public getValue(key: string): string | undefined {
        return this.state.values?.[key];
    }

    public getTrackedTasks(tasksFileName: string): ITrackedTask[] {
        if (this.state.trackedTasks === undefined) {
            return [];
        }

        const trackedForTasksFile = this.state.trackedTasks[tasksFileName];
        if (trackedForTasksFile === undefined) {
            return [];
        }
        return trackedForTasksFile;
    }

    public setTrackedTasks(tasksFileName: string, trackedTasks: ITrackedTask[]): void {
        if (this.state.trackedTasks === undefined) {
            this.state.trackedTasks = {};
        }

        this.state.trackedTasks[tasksFileName] = trackedTasks;
        this.dirty = true;
    }

    public getGenericTarget<ITaskDefinition>(type: string, organizationLogicalName: string, logicalNamespace: string | undefined, logicalName: string, accountId: string, region?: string): IGenericTarget<ITaskDefinition> | undefined {
        if (!region) {
            region = 'no-region';
        }

        if (logicalNamespace === undefined) {
            logicalNamespace = 'default';
        }

        const targetsOfType = this.state.targets?.[type];
        if (!targetsOfType) { return undefined; }

        const targetsWithOrganization = targetsOfType[organizationLogicalName];
        if (!targetsWithOrganization) { return undefined; }


        const targetsWithNamespace = targetsWithOrganization[logicalNamespace];
        if (!targetsWithNamespace) { return undefined; }


        const targetsWithName = targetsWithNamespace[logicalName];
        if (!targetsWithName) { return undefined; }

        const targetsForAccount = targetsWithName[accountId];
        if (!targetsForAccount) { return undefined; }

        return targetsForAccount[region] as IGenericTarget<ITaskDefinition>;
    }

    public setGenericTarget<ITaskDefinition>(target: IGenericTarget<ITaskDefinition>): void {

        const namespace = target.logicalNamePrefix ?? 'default';

        if (this.state.targets === undefined) {
            this.state.targets = {};
        }

        let targetsOfType = this.state.targets[target.targetType];
        if (!targetsOfType) {
            targetsOfType = this.state.targets[target.targetType] = {};
        }


        let targetsOfOrganization = targetsOfType[target.organizationLogicalName];
        if (!targetsOfOrganization) {
            targetsOfOrganization = targetsOfType[target.organizationLogicalName] = {};
        }

        let targetsWithNameSpace = targetsOfOrganization[namespace];
        if (!targetsWithNameSpace) {
            targetsWithNameSpace = targetsOfOrganization[namespace] = {};
        }

        let targetsWithName = targetsWithNameSpace[target.logicalName];
        if (!targetsWithName) {
            targetsWithName = targetsWithNameSpace[target.logicalName] = {};
        }

        let targetsForAccount = targetsWithName[target.accountId];
        if (!targetsForAccount) {
            targetsForAccount = targetsWithName[target.accountId] = {};
        }
        let region = target.region;
        if (!region) {
            region = 'no-region';
        }

        targetsForAccount[region]  = target;
        this.dirty = true;
    }

    public removeGenericTarget(type: string, organizationLogicalName: string, namespace = 'default', logicalName: string, accountId: string, region?: string): void {

        if (!region) {
            region = 'no-region';
        }

        const root = this.state.targets;
        if (!root) {
            return;
        }
        const organizations = root[type];
        if (!organizations) {
            return;
        }

        const namespaces = organizations[organizationLogicalName];
        if (!namespaces) {
            return;
        }

        const names = namespaces[namespace];
        if (!names) {
            return;
        }

        const accounts = names[logicalName];
        if (!accounts) {
            return;
        }
        const regions: Record<string, any> = accounts[accountId];
        if (!regions) {
            return;
        }

        delete regions[region];
        this.dirty = true;

        if (Object.keys(regions).length === 0) {
            delete accounts[accountId];

            if (Object.keys(accounts).length === 0) {
                delete names[logicalName];

                if (Object.keys(names).length === 0) {
                    delete namespaces[namespace];

                    if (Object.keys(namespaces).length === 0) {
                        delete organizations[organizationLogicalName];

                        if (Object.keys(organizations).length === 0) {
                            delete root[type];
                        }
                    }
                }
            }
        }
    }

    public getTarget(stackName: string, accountId: string, region: string): ICfnTarget | undefined {
        const accounts = this.state.stacks?.[stackName];
        if (!accounts) { return undefined; }

        const regions = accounts[accountId];
        if (!regions) { return undefined; }

        return regions[region];
    }

    public setTarget(templateTarget: ICfnTarget): void {
        if (this.state.stacks === undefined) {
            this.state.stacks = {};
        }

        let accounts = this.state.stacks[templateTarget.stackName];

        if (!accounts) {
            accounts = this.state.stacks[templateTarget.stackName] = {};
        }
        let regions: Record<string, ICfnTarget> = accounts[templateTarget.accountId];
        if (!regions) {
            regions = accounts[templateTarget.accountId] = {};
        }

        regions[templateTarget.region]  = templateTarget;
        this.dirty = true;
    }

    public listStacks(): string[] {
        return Object.entries(this.state.stacks).map(x => x[0]);
    }

    public enumTargets(stackName: string): ICfnTarget[] {
        const stacks = this.state.stacks;
        if (!stacks) { return []; }

        const result: ICfnTarget[] = [];
        for (const stack in stacks) {
            if (stack !== stackName) { continue; }
            const accounts = stacks[stack];
            for (const account in accounts) {
                const regions = accounts[account];
                for (const region in regions) {
                    result.push(regions[region]);
                }
            }
        }
        return result;
    }

    public removeTarget(stackName: string, accountId: string, region: string): void {
        const accounts = this.state.stacks[stackName];
        if (!accounts) {
            return;
        }
        const regions: Record<string, ICfnTarget> = accounts[accountId];
        if (!regions) {
            return;
        }

        delete regions[region];
        this.dirty = true;
        if (Object.keys(regions).length === 0) {
            delete accounts[accountId];

            if (Object.keys(accounts).length === 0) {
                delete this.state.stacks[stackName];
            }
        }
    }

    public getAccountBinding(logicalId: string): IBinding | undefined {
        if (this.organizationLevelState === false) {
            return this.organizationState.getAccountBinding(logicalId);
        }
        const typeDict = this.state.bindings?.[OrgResourceTypes.MasterAccount];
        if (!typeDict) {
            return this.getBinding(OrgResourceTypes.Account, logicalId);
        }

        const result = typeDict[logicalId];
        if (result === undefined) {
            return this.getBinding(OrgResourceTypes.Account, logicalId);
        }
        return result;
    }

    public getBinding(type: string, logicalId: string): IBinding | undefined {
        if (this.organizationLevelState === false) {
            return this.organizationState.getBinding(type, logicalId);
        }

        const typeDict = this.state.bindings?.[type];
        if (!typeDict) { return undefined; }

        const result = typeDict[logicalId];
        if (result === undefined) {
            ConsoleUtil.LogDebug(`unable to find binding for ${type}/${logicalId}`);
        }
        return result;
    }

    public enumBindings(type: string): IBinding[] {
        if (this.organizationLevelState === false) {
            return this.organizationState.enumBindings(type);
        }
        if (this.state.bindings === undefined) {
            return [];
        }
        const typeDict = this.state.bindings[type];
        if (!typeDict) { return []; }

        const result: IBinding[] = [];
        for (const key in typeDict) {
            result.push(typeDict[key]);
        }
        return result;
    }

    getLogicalIdForPhysicalId(physicalId: string): string | undefined {
        if (this.organizationLevelState === false) {
            return this.organizationState.getLogicalIdForPhysicalId(physicalId);
        }
        if (this.masterAccount === physicalId) {
            const binding = this.enumBindings(OrgResourceTypes.MasterAccount);
            if (binding && binding.length > 0) {
                return binding[0].logicalId;
            }
            return 'master account';
        }
        const bindings = this.enumBindings(OrgResourceTypes.Account);
        for(const binding of bindings) {
            if (binding.physicalId === physicalId) {
                return binding.logicalId;
            }
        }
        return undefined;
    }

    public enumGenericTargets<ITaskDefinition>(type: string, organizationName: string, namespace = 'default', name: string): IGenericTarget<ITaskDefinition>[] {
        if (this.organizationLevelState === false) {
            return this.organizationState.enumGenericTargets(type, organizationName, namespace, name);
        }
        if (this.state.targets === undefined) {
            return [];
        }
        const organizationDict = this.state.targets[type];
        if (!organizationDict) { return []; }

        const namespaceDict = organizationDict[organizationName];
        if (namespaceDict === undefined) {
            return [];
        }

        const nameDict = namespaceDict[namespace];
        if (nameDict === undefined) {
            return [];
        }

        const accountDict = nameDict[name];
        if (accountDict === undefined) {
            return [];
        }
        const result: IGenericTarget<ITaskDefinition>[] = [];
        for(const regionDict of Object.values(accountDict)) {
            for(const target of Object.values(regionDict)) {
                result.push(target as IGenericTarget<ITaskDefinition>);
            }
        }
        return result;
    }

    public setUniqueBindingForType(binding: IBinding): void {
        if (this.organizationLevelState === false) {
            this.organizationState.setUniqueBindingForType(binding);
            return;
        }
        if (this.readonly) {
            throw new OrgFormationError('attempt to modify to read-only organization level state');
        }

        if (this.state.bindings === undefined) {
            this.state.bindings = {};
        }
        let typeDict: Record<string, IBinding> = this.state.bindings[binding.type];
        typeDict = this.state.bindings[binding.type] = {};

        typeDict[binding.logicalId]  = binding;
        this.dirty = true;
    }

    public setBinding(binding: IBinding): void {
        if (this.organizationLevelState === false) {
            this.organizationState.setBinding(binding);
            return;
        }
        if (this.readonly) {
            throw new OrgFormationError('attempt to modify to read-only organization level state');
        }
        if (this.state.bindings === undefined) {
            this.state.bindings = {};
        }
        let typeDict: Record<string, IBinding> = this.state.bindings[binding.type];
        if (!typeDict) {
            typeDict = this.state.bindings[binding.type] = {};
        }

        typeDict[binding.logicalId]  = binding;
        this.dirty = true;
    }

    public setBindingHash(type: string, logicalId: string, lastCommittedHash: string): void {
        if (this.organizationLevelState === false) {
            this.organizationState.setBindingHash(type, logicalId, lastCommittedHash);
            return;
        }
        if (this.readonly) {
            throw new OrgFormationError('attempt to modify to read-only organization level state');
        }
        if (this.state.bindings === undefined) {
            this.state.bindings = {};
        }
        let typeDict: Record<string, IBinding> = this.state.bindings[type];
        if (!typeDict) {
            typeDict = this.state.bindings[type] = {};
        }

        const current = typeDict[logicalId];
        if (current === undefined){
            typeDict[logicalId] = { lastCommittedHash, logicalId, type } as IBinding;
        } else {
            current.lastCommittedHash = lastCommittedHash;
        }
        this.dirty = true;
    }

    public setBindingPhysicalId(type: string, logicalId: string, physicalId: string): void {
        if (this.organizationLevelState === false) {
            this.organizationState.setBindingHash(type, logicalId, physicalId);
            return;
        }
        if (this.readonly) {
            throw new OrgFormationError('attempt to modify to read-only organization level state');
        }
        let typeDict: Record<string, IBinding> = this.state.bindings[type];
        if (!typeDict) {
            typeDict = this.state.bindings[type] = {};
        }

        const current = typeDict[logicalId];
        if (current === undefined){
            typeDict[logicalId] = { physicalId, logicalId, type } as IBinding;
        } else {
            current.physicalId = physicalId;
        }
        this.dirty = true;
    }

    public removeBinding(binding: IBinding): void {
        if (this.organizationLevelState === false) {
            this.organizationState.removeBinding(binding);
            return;
        }
        if (this.readonly) {
            throw new OrgFormationError('attempt to modify to read-only organization level state');
        }
        let typeDict: Record<string, IBinding> = this.state.bindings[binding.type];
        if (!typeDict) {
            typeDict = this.state.bindings[binding.type] = {};
        }

        delete typeDict[binding.logicalId];
        this.dirty = true;
    }

    public setPreviousTemplate(template: string): void {
        if (this.organizationLevelState === false) {
            this.organizationState.setPreviousTemplate(template);
            return;
        }
        if (this.readonly) {
            throw new OrgFormationError('attempt to modify to read-only organization level state');
        }
        this.state.previousTemplate = template;
        this.dirty = true;
    }

    public getPreviousTemplate(): string {
        if (this.organizationLevelState === false) {
            return this.organizationState.getPreviousTemplate();
        }
        return this.state.previousTemplate;
    }

    public async save(storageProvider: IStorageProvider | undefined = this.provider, isGovCloud: boolean | undefined = false): Promise<void> {
        if (!storageProvider) { return; }
        /**
         * I wasn't able to figure out the concept of "dirty," so unsure if this was the way to handle it.
         */
        if (!this.dirty && !isGovCloud) { return; }
        const json = this.toJson();
        await storageProvider.put(json);

        this.dirty = false;
    }


    performUpdateToVersion2IfNeeded(): void {
        if (this.organizationLevelState === false) {
            return;
        }
        const storedVersion = this.getValue('state-version');
        if (storedVersion === undefined) {
            this.state.trackedTasks = {};
            if (this.state.targets) {
                for(const root of Object.entries(this.state.targets)) {
                    for(const logicalName of Object.entries(root[1])) {
                        for(const account of Object.entries(logicalName[1])) {
                            for(const region of Object.entries(account[1])) {
                                if ((region[1] as any).lastCommittedHash) {
                                    delete root[1][logicalName[0]];
                                    break;
                                }
                                break;
                            }
                            break;
                        }
                    }
                }
            }
            this.putValue('state-version', '2');
        }
    }

    public toJson(): string {
        return JSON.stringify(this.state, null, 2);
    }
}

export interface IState {
    targets?: Record<string, Record<string, Record<string, Record<string, Record<string, Record<string, IGenericTarget<unknown>>>>>>>;
    masterAccountId: string;
    bindings: Record<string, Record<string, IBinding>>;
    stacks: Record<string, Record<string, Record<string, ICfnTarget>>>;
    values: Record<string, string>;
    trackedTasks: Record<string, ITrackedTask[]>;
    previousTemplate: string;
}

export interface IBinding {
    logicalId: string;
    type: string;
    physicalId: string;
    lastCommittedHash: string;
    govCloudId?: string;
}

export interface ICfnTarget {
    logicalAccountId: string;
    region: string;
    accountId: string;
    stackName: string;
    customRoleName?: string;
    customViaRoleArn?: string;
    cloudFormationRoleName?: string;
    terminationProtection?: boolean;
    lastCommittedHash: string;
}

export interface IGenericTarget<TTaskDefinition> {
    targetType: string;
    logicalAccountId: string;
    region: string;
    accountId: string;
    logicalName: string;
    organizationLogicalName: string;
    logicalNamePrefix?: string;
    lastCommittedHash: string;
    lastCommittedLocalHash?: string;
    definition: TTaskDefinition;
}

export interface ITrackedTask {
    logicalName: string;
    physicalIdForCleanup: string;
    type: string;
}
