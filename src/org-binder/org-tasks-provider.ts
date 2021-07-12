import { ConsoleUtil } from '../util/console-util';
import { AwsOrganizationWriter } from '~aws-provider/aws-organization-writer';
import {
    AccountResource,
    OrganizationRootResource,
    OrganizationalUnitResource,
    OrgResourceTypes,
    PasswordPolicyResource,
    Reference,
    Resource,
    ServiceControlPolicyResource,
} from '~parser/model';
import { TemplateRoot } from '~parser/parser';
import { IBinding, PersistedState } from '~state/persisted-state';


export class TaskProvider {
    private state: PersistedState;
    private previousTemplate: TemplateRoot;
    private writer: AwsOrganizationWriter;

    constructor(currentTemplate: TemplateRoot, persistedState: PersistedState, writer: AwsOrganizationWriter) {
        this.writer = writer;
        this.state = persistedState;
        try {
            const previousTemplate = persistedState.getPreviousTemplate();
            if (previousTemplate) {
                this.previousTemplate = TemplateRoot.createFromContents(previousTemplate, currentTemplate.dirname);
            } else {
                this.previousTemplate = TemplateRoot.createEmpty();
            }
        } catch (err) {
            ConsoleUtil.LogInfo(`unable to load previous state, using empty template instead. reason: ${err}`);
            this.previousTemplate = TemplateRoot.createEmpty();
        }
    }

    public createRootCreateTasks(resource: OrganizationRootResource, hash: string): IBuildTask[] {
        const that = this;
        const tasks: IBuildTask[] = [];
        const createOrganizationRootTask: IBuildTask = {
            type: resource.type,
            logicalId: resource.logicalId,
            action:  'Create',
            perform: async task => {
                task.result = await that.writer.ensureRoot();
            },
        };

        tasks.push(createOrganizationRootTask);

        for (const attachedSCP of resource.serviceControlPolicies) {
            const attachSCPTask: IBuildTask = this.createAttachSCPTask(resource, attachedSCP, that, () => createOrganizationRootTask.result);
            attachSCPTask.dependentTasks = [createOrganizationRootTask];
            tasks.push(attachSCPTask);
        }

        const createOrganizationRootCommitHashTask: IBuildTask = {
            type: resource.type,
            logicalId: resource.logicalId,
            action:  'CommitHash',
            dependentTasks: tasks,
            perform: async () => {
                that.state.setUniqueBindingForType({
                    type: resource.type,
                    logicalId: resource.logicalId,
                    lastCommittedHash: hash,
                    physicalId: createOrganizationRootTask.result,
                });
            },
        };

        return [...tasks, createOrganizationRootCommitHashTask];
    }

    public createRootUpdateTasks(resource: OrganizationRootResource, physicalId: string, hash: string): IBuildTask[] {
        const that = this;
        const tasks: IBuildTask[] = [];
        const previousResource = this.previousTemplate.organizationSection.organizationRoot;
        const previosuServiceControlPolicies = previousResource ? previousResource.serviceControlPolicies : [];

        const previousSCPs = this.resolveIDs(previosuServiceControlPolicies);
        const currentSCPS = this.resolveIDs(resource.serviceControlPolicies);
        for (const attachedSCP of currentSCPS.physicalIds.filter(x => !previousSCPs.physicalIds.includes(x))) {
            const attachSCPTask: IBuildTask = this.createAttachSCPTask(resource, currentSCPS.mapping[attachedSCP], that, () => physicalId);
            tasks.push(attachSCPTask);
        }
        for (const attachedSCP of currentSCPS.unresolvedResources) {
            const attachSCPTask: IBuildTask = this.createAttachSCPTask(resource, { TemplateResource: attachedSCP as ServiceControlPolicyResource }, that, () => physicalId);
            tasks.push(attachSCPTask);
        }
        for (const detachedSCP of previousSCPs.physicalIds.filter(x => !currentSCPS.physicalIds.includes(x))) {
            const detachSCPTask: IBuildTask = this.createDetachSCPTask(resource, previousSCPs.mapping[detachedSCP], that, () => physicalId);
            tasks.push(detachSCPTask);
        }

        const createOrganizationalUnitCommitHashTask: IBuildTask = {
            type: resource.type,
            logicalId: resource.logicalId,
            action:  'CommitHash',
            dependentTasks: tasks,
            perform: async () => {
                that.state.setUniqueBindingForType({
                    type: resource.type,
                    logicalId: resource.logicalId,
                    lastCommittedHash: hash,
                    physicalId,
                });
            },
        };

        return [...tasks, createOrganizationalUnitCommitHashTask];
    }

    public createPolicyCreateTasks(resource: ServiceControlPolicyResource, hash: string): IBuildTask[] {
        const that = this;
        return [{
            type: resource.type,
            logicalId: resource.logicalId,
            action: 'Create',
            perform: async (task): Promise<void> => {
                const physicalId = await that.writer.createPolicy(resource);
                that.state.setBinding({
                    type: resource.type,
                    logicalId: resource.logicalId,
                    lastCommittedHash: hash,
                    physicalId,
                });
                task.result = physicalId;
            },
        }];
    }

    public createPolicyUpdateTasks(resource: ServiceControlPolicyResource, physicalId: string, hash: string): IBuildTask[] {
        const that = this;
        return [{
            type: resource.type,
            logicalId: resource.logicalId,
            action: 'Update',
            perform: async (): Promise<void> => {
                await that.writer.updatePolicy(resource, physicalId);
                that.state.setBinding({
                        type: resource.type,
                        logicalId: resource.logicalId,
                        lastCommittedHash: hash,
                        physicalId,
                    });
            },
        }];
    }

    public createPolicyDeleteTasks(binding: IBinding): IBuildTask[] {
        const that = this;
        return [{
            type: binding.type,
            logicalId: binding.logicalId,
            action: 'Delete',
            dependentTaskFilter: (): boolean => true,
            perform: async (): Promise<void> => {
                await that.writer.deletePolicy(binding.physicalId);
                this.state.removeBinding(binding);
            },
        }];
    }

    public createOrganizationalUnitCreateTasks(resource: OrganizationalUnitResource, hash: string): IBuildTask[] {
        const that = this;
        const tasks: IBuildTask[] = [];
        const createOrganizationalUnitTask: IBuildTask = {
            type: resource.type,
            logicalId: resource.logicalId,
            action:  'Create',
            dependentTaskFilter: task => task.action === 'Delete' && task.type === resource.type,
            perform: async (task): Promise<void> => {
                let parentId: string;
                if (resource.parentOULogicalName) {
                    const binding = that.state.getBinding(OrgResourceTypes.OrganizationalUnit, resource.parentOULogicalName);
                    if (binding) {
                        parentId = binding.physicalId;
                    }
                }
                task.result = await that.writer.createOrganizationalUnit(resource, parentId);
                that.state.setBindingPhysicalId(resource.type, resource.logicalId, createOrganizationalUnitTask.result);
            },
        };

        tasks.push(createOrganizationalUnitTask);

        for (const attachedSCP of resource.serviceControlPolicies) {
            const attachSCPTask: IBuildTask = this.createAttachSCPTask(resource, attachedSCP, that, () => createOrganizationalUnitTask.result);
            attachSCPTask.dependentTasks = [createOrganizationalUnitTask];
            tasks.push(attachSCPTask);
        }

        for (const attachedAccount of resource.accounts) {
            const attachAccountTask = this.createAttachAccountTask(resource, attachedAccount, that, () => createOrganizationalUnitTask.result);
            attachAccountTask.dependentTasks = [createOrganizationalUnitTask];
            tasks.push(attachAccountTask);
        }

        for (const attachedOu of resource.organizationalUnits) {
            const attachOuTask = this.createAttachOrganizationalUnitTask(resource, attachedOu, that, () => this.state.getBinding(OrgResourceTypes.OrganizationalUnit, createOrganizationalUnitTask.logicalId).physicalId);
            attachOuTask.dependentTasks = [createOrganizationalUnitTask];
            tasks.push(attachOuTask);
        }

        const createOrganizationalUnitCommitHashTask: IBuildTask = {
            type: resource.type,
            logicalId: resource.logicalId,
            action:  'CommitHash',
            dependentTasks: tasks,
            perform: async () => {
                that.state.setBindingHash(resource.type, resource.logicalId, hash);
            },
        };

        return [...tasks, createOrganizationalUnitCommitHashTask];
    }

    public createOrganizationalUnitUpdateTasks(resource: OrganizationalUnitResource, physicalId: string,  hash: string): IBuildTask[] {
        const that = this;
        const tasks: IBuildTask[] = [];
        const previousResource = this.previousTemplate.organizationSection.organizationalUnits.find(x => x.logicalId === resource.logicalId);

        if (previousResource === undefined || previousResource.organizationalUnitName !== resource.organizationalUnitName) {
            const updateOrganizationalUnitTask: IBuildTask = {
                type: resource.type,
                logicalId: resource.logicalId,
                action:  'Update',
                perform: async (task): Promise<void> => {
                    task.result = await that.writer.updateOrganizationalUnit(resource, physicalId);
                },
            };

            tasks.push(updateOrganizationalUnitTask);
        }

        const fnGetPhysicalId = (): string => {
            return this.state.getBinding(OrgResourceTypes.OrganizationalUnit, resource.logicalId).physicalId;
        };

        const previousSCPs = this.resolveIDs(previousResource === undefined ? [] : previousResource.serviceControlPolicies);
        const currentSCPS = this.resolveIDs(resource.serviceControlPolicies);
        for (const detachedSCP of previousSCPs.physicalIds.filter(x => !currentSCPS.physicalIds.includes(x))) {
            const detachSCPTask: IBuildTask = this.createDetachSCPTask(resource, previousSCPs.mapping[detachedSCP], that, fnGetPhysicalId);
            tasks.push(detachSCPTask);
        }
        for (const attachedSCP of currentSCPS.physicalIds.filter(x => !previousSCPs.physicalIds.includes(x))) {
            const attachSCPTask: IBuildTask = this.createAttachSCPTask(resource, currentSCPS.mapping[attachedSCP], that, fnGetPhysicalId);
            tasks.push(attachSCPTask);
        }
        for (const attachedSCP of currentSCPS.unresolvedResources) {
            const attachSCPTask: IBuildTask = this.createAttachSCPTask(resource, { TemplateResource: attachedSCP as ServiceControlPolicyResource }, that, fnGetPhysicalId);
            tasks.push(attachSCPTask);
        }

        const previousAccounts = this.resolveIDs(previousResource === undefined ? [] : previousResource.accounts);
        const currentAccounts = this.resolveIDs(resource.accounts);
        for (const detachedAccount of previousAccounts.physicalIds.filter(x => !currentAccounts.physicalIds.includes(x))) {
            const detachAccountTask: IBuildTask = this.createDetachAccountTask(resource, previousAccounts.mapping[detachedAccount], that, fnGetPhysicalId);
            tasks.push(detachAccountTask);
        }
        for (const attachAccount of currentAccounts.physicalIds.filter(x => !previousAccounts.physicalIds.includes(x))) {
            const attachAccountTask: IBuildTask = this.createAttachAccountTask(resource, currentAccounts.mapping[attachAccount], that, fnGetPhysicalId);
            tasks.push(attachAccountTask);
        }
        for (const attachAccount of currentAccounts.unresolvedResources) {
            const attachAccountTask: IBuildTask = this.createAttachAccountTask(resource, { TemplateResource: attachAccount as AccountResource }, that, fnGetPhysicalId);
            tasks.push(attachAccountTask);
        }

        const previousChildOUs = this.resolveIDs(previousResource === undefined ? [] : previousResource.organizationalUnits);
        const currentChildOUs = this.resolveIDs(resource.organizationalUnits);
        for (const detachedChildOu of previousChildOUs.physicalIds.filter(x => !currentChildOUs.physicalIds.includes(x))) {
            const detachChildOuTask: IBuildTask = this.createDetachChildOUTask(resource, previousChildOUs.mapping[detachedChildOu], that, fnGetPhysicalId);
            tasks.push(detachChildOuTask);
        }
        for (const attachedOU of currentChildOUs.physicalIds.filter(x => !previousChildOUs.physicalIds.includes(x))) {
            const attachOUTask: IBuildTask = this.createAttachOrganizationalUnitTask(resource, currentChildOUs.mapping[attachedOU], that, fnGetPhysicalId);
            tasks.push(attachOUTask);
        }
        for (const attachedOU of currentChildOUs.unresolvedResources) {
            const attachOUTask: IBuildTask = this.createAttachOrganizationalUnitTask(resource, { TemplateResource: attachedOU as OrganizationalUnitResource }, that, fnGetPhysicalId);
            tasks.push(attachOUTask);
        }

        const createOrganizationalUnitCommitHashTask: IBuildTask = {
            type: resource.type,
            logicalId: resource.logicalId,
            action:  'CommitHash',
            dependentTasks: tasks,
            perform: async (): Promise<void> => {
                that.state.setBindingHash(resource.type, resource.logicalId, hash);
            },
        };

        return [...tasks, createOrganizationalUnitCommitHashTask];
    }
    public createDetachChildOUTask(resource: OrganizationalUnitResource, childOu: Reference<OrganizationalUnitResource>, that: this, getTargetId: () => string): IBuildTask {
        let resourceIdentifier = childOu.PhysicalId;
        if (childOu.TemplateResource) {
            resourceIdentifier = childOu.TemplateResource.logicalId;
        }
        const childLogicalId = childOu.TemplateResource.logicalId;
        const detachChildOuTask: IBuildTask = {
            type: resource.type,
            logicalId: resource.logicalId,
            action: `Detach OU (${resourceIdentifier})`,
            perform: async (task): Promise<void> => {
                const binding = that.state.getBinding(OrgResourceTypes.OrganizationalUnit, childLogicalId);
                if (binding === undefined) {
                    ConsoleUtil.LogDebug(`resource ${childLogicalId} was already deleted`);
                    return;
                }
                const childOuId = binding.physicalId;

                const targetId = getTargetId();
                let physicalIdMap: Record<string, string> = {};
                try {
                    physicalIdMap = await that.writer.detachOU(targetId, childOuId);
                }
                finally {
                    TaskProvider.updateStateWithOuPhysicalIds(that.state, physicalIdMap);
                }

                task.result = physicalIdMap;
            },
        };
        if (childOu.TemplateResource && undefined === that.state.getBinding(OrgResourceTypes.OrganizationalUnit, childLogicalId)) {
            detachChildOuTask.dependentTaskFilter = (task): boolean => task.logicalId === childLogicalId &&
                (task.action === 'Create') &&
                task.type === OrgResourceTypes.OrganizationalUnit;
        }
        else  {
            detachChildOuTask.dependentTaskFilter = (task): boolean => task.logicalId === childLogicalId &&
                (task.action === 'Delete') &&
                task.type === OrgResourceTypes.OrganizationalUnit;
        }
        return detachChildOuTask;
    }

    public createOrganizationalUnitDeleteTasks(binding: IBinding): IBuildTask[] {
        const that = this;
        const tasks: IBuildTask[] = [];
        const previous = this.previousTemplate.organizationSection.organizationalUnits.find(x=>x.logicalId === binding.logicalId);

        const fnGetPhysicalId = (): string => {
            return this.state.getBinding(OrgResourceTypes.OrganizationalUnit, previous.logicalId).physicalId;
        };


        const previousSCPs = this.resolveIDs(previous.serviceControlPolicies);
        for (const detachedSCP of previousSCPs.physicalIds) {
            const detachSCPTask: IBuildTask = this.createDetachSCPTask(previous, previousSCPs.mapping[detachedSCP], that, fnGetPhysicalId);
            tasks.push(detachSCPTask);
        }

        const previousAccounts = this.resolveIDs(previous.accounts);
        for (const detachedAccount of previousAccounts.physicalIds) {
            const detachAccountTask: IBuildTask = this.createDetachAccountTask(previous, previousAccounts.mapping[detachedAccount], that, fnGetPhysicalId);
            tasks.push(detachAccountTask);
        }

        const previousChildOUs = this.resolveIDs(previous.organizationalUnits);
        for (const detachedChildOu of previousChildOUs.physicalIds) {
            const detachChildOuTask: IBuildTask = this.createDetachChildOUTask(previous, previousChildOUs.mapping[detachedChildOu], that, fnGetPhysicalId);
            tasks.push(detachChildOuTask);
        }

        const task: IBuildTask = {
            type: binding.type,
            logicalId: binding.logicalId,
            action: 'Delete',
            dependentTasks: tasks,
            perform: async (): Promise<void> => {
                await that.writer.deleteOrganizationalUnit(binding.physicalId);
                this.state.removeBinding(binding);
            },
        };

        if (previous !== undefined && previous.organizationalUnits.length > 0) {
            task.dependentTaskFilter = (x): boolean => {
                for(const child of previous.organizationalUnits) {
                    if (child.TemplateResource && child.TemplateResource.logicalId === x.logicalId) {
                        return true;
                    }
                }
                return (x.logicalId === binding.logicalId);
            };
        }
        return [...tasks, task];
    }

    public createAccountUpdateTasks(resource: AccountResource, physicalId: string, hash: string): IBuildTask[] {
        const that = this;
        const tasks: IBuildTask[] = [];
        let previousResource = [...this.previousTemplate.organizationSection.accounts].find(x => x.logicalId === resource.logicalId);
        if (!previousResource && resource.type === OrgResourceTypes.MasterAccount) {
            previousResource = this.previousTemplate.organizationSection.masterAccount;
        }

        if (previousResource === undefined || previousResource.alias !== resource.alias || previousResource.accountName !== resource.accountName || previousResource.supportLevel !== resource.supportLevel || JSON.stringify(previousResource.tags) !== JSON.stringify(resource.tags)
            || !policiesEqual(previousResource.passwordPolicy, resource.passwordPolicy)) {
            const updateAccountTask: IBuildTask = {
                type: resource.type,
                logicalId: resource.logicalId,
                action:  'Update',
                perform: async (task): Promise<void> => {
                    task.result = await that.writer.updateAccount(resource, physicalId, previousResource);
                },
            };

            tasks.push(updateAccountTask);
        }

        const previousPolicies = previousResource === undefined ? [] : previousResource.serviceControlPolicies;
        const previousSCPs = this.resolveIDs(previousPolicies);
        const currentSCPS = this.resolveIDs(resource.serviceControlPolicies);
        for (const detachedSCP of previousSCPs.physicalIds.filter(x => !currentSCPS.physicalIds.includes(x))) {
            const detachSCPTask: IBuildTask = this.createDetachSCPTask(resource, previousSCPs.mapping[detachedSCP], that, () => physicalId);
            tasks.push(detachSCPTask);
        }
        for (const attachedSCP of currentSCPS.physicalIds.filter(x => !previousSCPs.physicalIds.includes(x))) {
            const attachSCPTask: IBuildTask = this.createAttachSCPTask(resource, currentSCPS.mapping[attachedSCP], that, () => physicalId);
            tasks.push(attachSCPTask);
        }
        for (const attachedSCP of currentSCPS.unresolvedResources) {
            const attachSCPTask: IBuildTask = this.createAttachSCPTask(resource, { TemplateResource: attachedSCP as ServiceControlPolicyResource }, that, () => physicalId);
            tasks.push(attachSCPTask);
        }
        const createAccountCommitHashTask: IBuildTask = {
            type: resource.type,
            logicalId: resource.logicalId,
            action:  'CommitHash',
            dependentTasks: tasks,
            perform: async (): Promise<void> => {
                if (resource.type === OrgResourceTypes.MasterAccount) {
                    that.state.setUniqueBindingForType({
                        type: resource.type,
                        logicalId: resource.logicalId,
                        lastCommittedHash: hash,
                        physicalId,
                    });
                } else {
                    that.state.setBinding({
                        type: resource.type,
                        logicalId: resource.logicalId,
                        lastCommittedHash: hash,
                        physicalId,
                    });
                }
            },
        };

        return [...tasks, createAccountCommitHashTask];
    }

    public createGovCloudAccountUpdateTasks(resource: AccountResource, physicalId: string, govCloudId: string, hash: string): IBuildTask[] {
        const that = this;
        const tasks: IBuildTask[] = [];
        let previousResource = [...this.previousTemplate.organizationSection.accounts].find(x => x.logicalId === resource.logicalId);
        if (!previousResource && resource.type === OrgResourceTypes.MasterAccount) {
            previousResource = this.previousTemplate.organizationSection.masterAccount;
        }

        if (previousResource === undefined || previousResource.alias !== resource.alias || previousResource.govCloudAlias !== resource.govCloudAlias || previousResource.accountName !== resource.accountName || previousResource.supportLevel !== resource.supportLevel || JSON.stringify(previousResource.tags) !== JSON.stringify(resource.tags)
            || !policiesEqual(previousResource.passwordPolicy, resource.passwordPolicy)) {
            const updateAccountTask: IBuildTask = {
                type: resource.type,
                logicalId: resource.logicalId,
                action:  'Update',
                perform: async (task): Promise<void> => {
                    task.result = {
                        commercial: await that.writer.updateAccount(resource, physicalId, previousResource),
                        govCloud: await that.writer.updateGovCloudAccount(resource, govCloudId, previousResource),
                    };
                },
            };

            tasks.push(updateAccountTask);
        }

        const createAccountCommitHashTask: IBuildTask = {
            type: resource.type,
            logicalId: resource.logicalId,
            action:  'CommitHash',
            dependentTasks: tasks,
            perform: async (): Promise<void> => {
                if (resource.type === OrgResourceTypes.MasterAccount) {
                    that.state.setUniqueBindingForType({
                        type: resource.type,
                        logicalId: resource.logicalId,
                        lastCommittedHash: hash,
                        physicalId,
                        govCloudId,
                    });
                } else {
                    that.state.setBinding({
                        type: resource.type,
                        logicalId: resource.logicalId,
                        lastCommittedHash: hash,
                        physicalId,
                        govCloudId,
                    });
                }
            },
        };

        return [...tasks, createAccountCommitHashTask];
    }

    public createAccountCreateTasks(resource: AccountResource, hash: string): IBuildTask[] {
        const that = this;
        const tasks: IBuildTask[] = [];
        const createAccountTask: IBuildTask = {
            type: resource.type,
            logicalId: resource.logicalId,
            action:  'Create',
            perform: async (task): Promise<void> => {
                task.result = await that.writer.createAccount(resource);
            },
        };

        tasks.push(createAccountTask);

        for (const attachedSCP of resource.serviceControlPolicies) {
            const attachSCPTask: IBuildTask = this.createAttachSCPTask(resource, attachedSCP, that, () => createAccountTask.result);
            attachSCPTask.dependentTasks = [createAccountTask];
            tasks.push(attachSCPTask);
        }

        const createAccountCommitHashTask: IBuildTask = {
            type: resource.type,
            logicalId: resource.logicalId,
            action:  'CommitHash',
            dependentTasks: tasks,
            perform: async (): Promise<void> => {
                if (resource.type === OrgResourceTypes.MasterAccount) {
                    that.state.setUniqueBindingForType({
                        type: resource.type,
                        logicalId: resource.logicalId,
                        lastCommittedHash: hash,
                        physicalId: createAccountTask.result,
                    });
                } else {
                    that.state.setBinding({
                        type: resource.type,
                        logicalId: resource.logicalId,
                        lastCommittedHash: hash,
                        physicalId: createAccountTask.result,
                    });
                }
            },
        };
        return [...tasks, createAccountCommitHashTask];
    }

    public createGovCloudAccountCreateTasks(resource: AccountResource, hash: string): IBuildTask[] {
        /**
         * Unsure if this needs its own entire block.
         */
        const that = this;
        const tasks: IBuildTask[] = [];
        const createGovCloudAccountTask: IBuildTask = {
            type: resource.type,
            logicalId: resource.logicalId,
            action:  'Create',
            perform: async (task): Promise<void> => {
                task.result = await that.writer.createGovCloudAccount(resource);
            },
        };

        tasks.push(createGovCloudAccountTask);

        for (const attachedSCP of resource.serviceControlPolicies) {
            const attachSCPTask: IBuildTask = this.createAttachSCPTask(resource, attachedSCP, that, () => createGovCloudAccountTask.result);
            attachSCPTask.dependentTasks = [createGovCloudAccountTask];
            tasks.push(attachSCPTask);
        }

        const createAccountCommitHashTask: IBuildTask = {
            type: resource.type,
            logicalId: resource.logicalId,
            action:  'CommitHash',
            dependentTasks: tasks,
            perform: async (): Promise<void> => {
                if (resource.type === OrgResourceTypes.MasterAccount) {
                    that.state.setUniqueBindingForType({
                        type: resource.type,
                        logicalId: resource.logicalId,
                        lastCommittedHash: hash,
                        physicalId: createGovCloudAccountTask.result,
                    });
                } else {
                    that.state.setBinding({
                        type: resource.type,
                        logicalId: resource.logicalId,
                        lastCommittedHash: hash,
                        physicalId: createGovCloudAccountTask.result.CommercialId,
                        govCloudId: createGovCloudAccountTask.result.GovCloudId,
                    });
                }
            },
        };
        return [...tasks, createAccountCommitHashTask];
    }

    public createForgetResourceTasks(binding: IBinding): IBuildTask[] {
        return [{
            type: binding.type,
            logicalId: binding.logicalId,
            action: 'Forget',
            perform: async (): Promise<void> => {
                this.state.removeBinding(binding);
            },
        }];
    }
    private createDetachSCPTask(resource: OrganizationalUnitResource | AccountResource | OrganizationRootResource, policy: Reference<ServiceControlPolicyResource>, that: this, getTargetId: () => string): IBuildTask {
        let scpIdentifier = policy.PhysicalId;
        if (policy.TemplateResource) {
            scpIdentifier = policy.TemplateResource.logicalId;
        }
        const targetId = getTargetId();
        return {
            type: resource.type,
            logicalId: resource.logicalId,
            action: `Detach Policy (${scpIdentifier})`,
            perform: async (task): Promise<void> => {
                task.result = await that.writer.detachPolicy(targetId, policy.PhysicalId);
            },
        };
    }

    private createAttachSCPTask(resource: Resource, policy: Reference<ServiceControlPolicyResource>, that: this, getTargetId: () => string): IBuildTask {
        let scpIdentifier = policy.PhysicalId;
        if (policy.TemplateResource) {
            scpIdentifier = policy.TemplateResource.logicalId;
        }
        const attachSCPTask: IBuildTask = {
            type: resource.type,
            logicalId: resource.logicalId,
            action: `Attach Policy (${scpIdentifier})`,
            perform: async (task): Promise<void> => {
                let policyId = policy.PhysicalId;
                if (policyId === undefined) {
                    const binding = that.state.getBinding(OrgResourceTypes.ServiceControlPolicy, policy.TemplateResource.logicalId);
                    policyId = binding.physicalId;
                }
                const targetId = getTargetId();
                task.result = await that.writer.attachPolicy(targetId, policyId);
            },
        };
        if (policy.TemplateResource && undefined === that.state.getBinding(OrgResourceTypes.ServiceControlPolicy, policy.TemplateResource.logicalId)) {
            attachSCPTask.dependentTaskFilter = (task): boolean => {
                return (task.logicalId === policy.TemplateResource.logicalId && task.action === 'Create' && task.type === OrgResourceTypes.ServiceControlPolicy)
                || (task.action.indexOf('Detach Policy') >= 0);
            };
        }
        return attachSCPTask;
    }

    private createDetachAccountTask(resource: OrganizationalUnitResource, account: Reference<AccountResource>, that: this, getTargetId: () => string): IBuildTask {
        let accountIdentifier = account.PhysicalId;
        if (account.TemplateResource) {
            accountIdentifier = account.TemplateResource.logicalId;
        }
        const detachAccountTask: IBuildTask = {
            type: resource.type,
            logicalId: resource.logicalId,
            action: `Detach Account (${accountIdentifier})`,
            perform: async (task): Promise<void> => {
                let accountId = account.PhysicalId;
                if (accountId === undefined) {
                    const binding = that.state.getBinding(account.TemplateResource.type, account.TemplateResource.logicalId);
                    accountId = binding.physicalId;
                }
                const targetId = getTargetId();
                task.result = await that.writer.detachAccount(targetId, accountId);
            },
        };
        if (account.TemplateResource && undefined === that.state.getBinding(account.TemplateResource.type, account.TemplateResource.logicalId)) {
            detachAccountTask.dependentTaskFilter = (task): boolean => task.logicalId === account.TemplateResource.logicalId &&
                task.action === 'Create' &&
                task.type === account.TemplateResource.type;
        }
        return detachAccountTask;
    }

    private createAttachAccountTask(resource: OrganizationalUnitResource, account: Reference<AccountResource>, that: this, getTargetId: () => string): IBuildTask {
        let accountIdentifier = account.PhysicalId;
        if (account.TemplateResource) {
            accountIdentifier = account.TemplateResource.logicalId;
        }
        const attachAccountTask: IBuildTask = {
            type: resource.type,
            logicalId: resource.logicalId,
            action: `Attach Account (${accountIdentifier})`,
            perform: async (task): Promise<void> => {
                let accountId = account.PhysicalId;
                if (accountId === undefined) {
                    const binding = that.state.getBinding(account.TemplateResource.type, account.TemplateResource.logicalId);
                    accountId = binding.physicalId;
                }
                const targetId = getTargetId();
                task.result = await that.writer.attachAccount(targetId, accountId);
            },
        };
        if (account.TemplateResource && undefined === that.state.getBinding(account.TemplateResource.type, account.TemplateResource.logicalId)) {
            attachAccountTask.dependentTaskFilter = (task): boolean => task.logicalId === account.TemplateResource.logicalId &&
                task.action === 'Create' &&
                task.type === account.TemplateResource.type;
        }
        return attachAccountTask;
    }

    private createAttachOrganizationalUnitTask(resource: OrganizationalUnitResource, childOu: Reference<OrganizationalUnitResource>, that: this, getTargetId: () => string): IBuildTask {
        let ouIdentifier = childOu.PhysicalId;
        if (childOu.TemplateResource) {
            ouIdentifier = childOu.TemplateResource.logicalId;
        }
        const attachChildOuTask: IBuildTask = {
            type: resource.type,
            logicalId: resource.logicalId,
            action: `Attach OU (${ouIdentifier})`,
            perform: async (task): Promise<void> => {
                const binding = that.state.getBinding(OrgResourceTypes.OrganizationalUnit, childOu.TemplateResource.logicalId);
                const childOuId = binding.physicalId;

                const targetId = getTargetId();
                const physicalIdMap: Record<string, string> = {};
                try {
                    await that.writer.moveOU(targetId, childOuId, physicalIdMap);
                } finally {
                    TaskProvider.updateStateWithOuPhysicalIds(that.state, physicalIdMap);
                }

                task.result = physicalIdMap;
            },
        };
        if (childOu.TemplateResource && undefined === that.state.getBinding(OrgResourceTypes.OrganizationalUnit, childOu.TemplateResource.logicalId)) {
            attachChildOuTask.dependentTaskFilter = (task): boolean => task.logicalId === childOu.TemplateResource.logicalId &&
                (task.action === 'Create'
                || task.action.startsWith('Detach OU')) && task.type === OrgResourceTypes.OrganizationalUnit;
        }
        return attachChildOuTask;
    }

    private resolveIDs<TResource extends Resource>(list: Reference<TResource>[]): IResolvedIDs<TResource> {
        const physicalIdsForServiceControlPolicies = list.filter(x => x.PhysicalId).map(x => x.PhysicalId);
        const unresolvedResources: TResource[] = [];
        const mapping: Record<string, Reference<TResource>> = {};
        for (const logicalRef of list.filter(x => x.TemplateResource)) {
            const binding = this.state.getBinding(logicalRef.TemplateResource.type, logicalRef.TemplateResource.logicalId);
            if (binding === undefined) {
                unresolvedResources.push(logicalRef.TemplateResource!);
            } else  {
                physicalIdsForServiceControlPolicies.push(binding.physicalId);
                mapping[binding.physicalId] = { ...logicalRef, PhysicalId: binding.physicalId};
            }
        }
        return {physicalIds: physicalIdsForServiceControlPolicies.sort(), unresolvedResources, mapping};
    }

    public static updateStateWithOuPhysicalIds(state: PersistedState, physicalIdMap: Record<string, string>): void {
        const organizationalUnitBindings = state.enumBindings(OrgResourceTypes.OrganizationalUnit);
        for(const binding of organizationalUnitBindings) {
            const newId = physicalIdMap[binding.physicalId];
            if (newId !== undefined) {
                ConsoleUtil.LogDebug(`mapping ${binding.logicalId} old ou ${binding.physicalId} to ${newId}`);
                binding.physicalId = newId;
                state.setBinding(binding);
            }
        }
    }
}


interface IResolvedIDs<TResource extends Resource> {
    physicalIds: string[];
    unresolvedResources: TResource[];
    mapping: Record<string, Reference<TResource>>;
}
export interface IBuildTask {
    type: string;
    logicalId: string;
    action: BuildTaskAction;
    result?: any;
    done?: boolean;
    dependentTasks?: IBuildTask[];
    dependentTaskFilter?: (task: IBuildTask) => boolean;
    perform: (task: IBuildTask) => Promise<void>;
}

type BuildTaskAction = 'Create' | 'Update' | 'Delete' | 'Relate' | 'Forget' | 'CommitHash' | string;

const policiesEqual = (left: Reference<PasswordPolicyResource> , right: Reference<PasswordPolicyResource>): boolean => {
    const leftNull = !left || !left.TemplateResource;
    const rightNull = !right || !right.TemplateResource;

    if (leftNull && rightNull) {
        return true;
    }
    if (leftNull || rightNull) {
        return false;
    }
    return left.TemplateResource!.calculateHash() === right.TemplateResource!.calculateHash();
};
