import { OrgFormationError } from '../org-formation-error';
import { IBuildTask, TaskProvider } from './org-tasks-provider';
import {
    AccountResource,
    MasterAccountResource,
    OrganizationRootResource,
    OrganizationalUnitResource,
    OrgResourceTypes,
    Resource,
    ServiceControlPolicyResource,
} from '~parser/model';
import { TemplateRoot } from '~parser/parser';
import { IBinding, PersistedState } from '~state/persisted-state';


export class OrganizationBinder {
    private taskProvider: TaskProvider;
    private template: TemplateRoot;
    private state: PersistedState;
    private masterAccount: string;

    constructor(template: TemplateRoot, state: PersistedState, taskProvider: TaskProvider) {
        this.template = template;
        this.taskProvider = taskProvider;
        this.masterAccount = template.organizationSection.masterAccount.accountId;
        this.state = state;
        if (this.state.masterAccount && this.masterAccount && this.state.masterAccount !== this.masterAccount) {
            throw new OrgFormationError('state and template do not belong to the same organization');
        }
    }

    public getBindings(): BindingRoot {
        return {
            organization: this.getOrganizationBinding(),
        };
    }

    public getOrganizationBinding(): OrganizationBinding {
        const policies = Array.from(ServiceControlPolicyBinding.enumerateServiceControlBindings(this.template, this.state));
        const organizationalUnits = Array.from(OrganizationalUnitBinding.enumerateOrganizationalUnitBindings(this.template, this.state));
        const accounts = Array.from(AccountBinding.enumerateAccountBindings(this.template, this.state));
        const masterAccount = Binding.getBindingOnType<MasterAccountResource>(this.state, this.template.organizationSection.masterAccount);
        const organizationRoot = Binding.getBindingOnType<OrganizationRootResource>(this.state, this.template.organizationSection.organizationRoot);

        return {
            policies,
            organizationalUnits,
            accounts,
            masterAccount,
            organizationRoot,
        };
    }

    public enumBuildTasks(): IBuildTask[] {
        const tasks: IBuildTask[] = [];
        const org = this.getOrganizationBinding();
        for (const boundPolicy of org.policies) {
            switch (boundPolicy.action) {
                case 'Create':
                    const t = this.taskProvider.createPolicyCreateTasks(boundPolicy.template, boundPolicy.templateHash);
                    tasks.push(...t);
                    break;
                case 'Update':
                    const t2 = this.taskProvider.createPolicyUpdateTasks(boundPolicy.template, boundPolicy.state.physicalId, boundPolicy.templateHash);
                    tasks.push(...t2);
                    break;
                case 'Delete':
                    const t3 = this.taskProvider.createPolicyDeleteTasks(boundPolicy.state);
                    tasks.push(...t3);
                    break;
            }
        }
        for (const boundPolicy of org.accounts) {
            switch (boundPolicy.action) {
                case 'Create':
                    let t1;
                    if (org?.organizationRoot?.template?.mirrorInGovCloud) {
                        t1 = this.taskProvider.createGovCloudAccountCreateTasks(boundPolicy.template, boundPolicy.templateHash);
                    } else {
                        t1 = this.taskProvider.createAccountCreateTasks(boundPolicy.template, boundPolicy.templateHash);
                    }
                    tasks.push(...t1);
                    break;
                case 'Update':
                    let t2;
                    if (org?.organizationRoot?.template?.mirrorInGovCloud) {
                        t2 = this.taskProvider.createGovCloudAccountUpdateTasks(boundPolicy.template, boundPolicy.state.physicalId, boundPolicy.state.govCloudId, boundPolicy.templateHash);
                    } else {
                        t2 = this.taskProvider.createAccountUpdateTasks(boundPolicy.template, boundPolicy.state.physicalId, boundPolicy.templateHash);
                    }
                    tasks.push(...t2);
                    break;
                case 'Delete':
                    const t3 = this.taskProvider.createForgetResourceTasks(boundPolicy.state);
                    tasks.push(...t3);
                    break;
            }
        }
        for (const boundPolicy of org.organizationalUnits) {
            switch (boundPolicy.action) {
                case 'Create':
                    const t1 = this.taskProvider.createOrganizationalUnitCreateTasks(boundPolicy.template, boundPolicy.templateHash);
                    tasks.push(...t1);
                    break;
                case 'Update':
                    const t2 = this.taskProvider.createOrganizationalUnitUpdateTasks(boundPolicy.template, boundPolicy.state.physicalId, boundPolicy.templateHash);
                    tasks.push(...t2);
                    break;
                case 'Delete':
                    const t3 = this.taskProvider.createOrganizationalUnitDeleteTasks(boundPolicy.state);
                    tasks.push(...t3);
                    break;
            }
        }

        if (org.masterAccount) {
            switch (org.masterAccount.action) {
                case 'Create':
                    const t1 = this.taskProvider.createAccountCreateTasks(org.masterAccount.template, org.masterAccount.templateHash);
                    tasks.push(...t1);
                    break;
                case 'Update':
                    const t2 = this.taskProvider.createAccountUpdateTasks(org.masterAccount.template, org.masterAccount.state.physicalId, org.masterAccount.templateHash);
                    tasks.push(...t2);
                    break;
                case 'Delete':
                    const t3 = this.taskProvider.createForgetResourceTasks(org.masterAccount.state);
                    tasks.push(...t3);
                    break;
            }
        }

        if (org.organizationRoot) {
            switch (org.organizationRoot.action) {
                case 'Create':
                    const t1 = this.taskProvider.createRootCreateTasks(org.organizationRoot.template, org.organizationRoot.templateHash);
                    tasks.push(...t1);
                    break;
                case 'Update':
                    const t2 = this.taskProvider.createRootUpdateTasks(org.organizationRoot.template, org.organizationRoot.state.physicalId, org.organizationRoot.templateHash);
                    tasks.push(...t2);
                    break;
                case 'Delete':
                    const t3 = this.taskProvider.createForgetResourceTasks(org.organizationRoot.state);
                    tasks.push(...t3);
                    break;
            }
        }
        return tasks;
    }
}

export class BindingRoot {
    public organization: OrganizationBinding;
}

export class OrganizationBinding {
    public policies: ServiceControlPolicyBinding[];
    public organizationalUnits: OrganizationalUnitBinding[];
    public accounts: AccountBinding[];
    public masterAccount: Binding<MasterAccountResource>;
    public organizationRoot: Binding<OrganizationRootResource>;
}

type BindingAction = 'Create' | 'Update' | 'Delete' | 'None';

class Binding<TResource extends Resource> {

    public static getBindingOnType<TResource extends Resource>(state: PersistedState, templateResource: TResource): Binding<TResource> {
        if (!templateResource) { return undefined; }
        const storedBindings = state.enumBindings(templateResource.type);
        const savedBinding = storedBindings.length > 0 ? storedBindings[0] : undefined;
        const hash = templateResource.calculateHash();
        if (savedBinding === undefined) {
            return {
                action: 'Create',
                template: templateResource,
                templateHash: hash,
            };
        } else if (hash !== savedBinding.lastCommittedHash) {
            return {
                action: 'Update',
                template: templateResource,
                state: savedBinding,
                templateHash: hash,
            };
        } else {
            return {
                action: 'None',
                template: templateResource,
                state: savedBinding,
                templateHash: hash,
            };
        }
    }

    public static getBinding<TResource extends Resource>(state: PersistedState, templateResource: TResource): Binding<TResource> {
        if (!templateResource) { return undefined; }
        const savedBinding = state.getBinding(templateResource.type, templateResource.logicalId);
        const hash = templateResource.calculateHash();
        if (savedBinding === undefined) {
            return {
                action: 'Create',
                template: templateResource,
                templateHash: hash,
            };
        } else if (hash !== savedBinding.lastCommittedHash) {
            return {
                action: 'Update',
                template: templateResource,
                state: savedBinding,
                templateHash: hash,
            };
        } else {
            return {
                action: 'None',
                template: templateResource,
                state: savedBinding,
                templateHash: hash,
            };
        }
    }

    protected static enumerateBindings<TResource extends Resource>(type: string, templateResources: TResource[], state: PersistedState): Binding<TResource>[] {
        const savedBindings = state.enumBindings(type);
        const result: Binding<TResource>[] = [];
        for (const templateResource of templateResources) {
            const binding = Binding.getBinding<TResource>(state, templateResource);
            result.push(binding);
        }

        for (const savedBinding of savedBindings) {
            if (!templateResources.find(x => x.logicalId === savedBinding.logicalId)) {
                const binding: Binding<TResource> = {
                    action: 'Delete',
                    state: savedBinding,
                };
                result.push(binding);
            }
        }
        return result;
    }
    public template?: TResource;
    public state?: IBinding;
    public action: BindingAction;
    public templateHash?: string;
}

class AccountBinding extends Binding<AccountResource> {

    public static enumerateAccountBindings(template: TemplateRoot, state: PersistedState): AccountBinding[] {
        return Binding.enumerateBindings<AccountResource>(
            OrgResourceTypes.Account,
            template.organizationSection.accounts,
            state);

    }
}

class OrganizationalUnitBinding extends Binding<OrganizationalUnitResource> {

    public static enumerateOrganizationalUnitBindings(template: TemplateRoot, state: PersistedState): OrganizationalUnitBinding[] {
        return Binding.enumerateBindings<OrganizationalUnitResource>(
            OrgResourceTypes.OrganizationalUnit,
            template.organizationSection.organizationalUnits,
            state);

    }
}

class ServiceControlPolicyBinding extends Binding<ServiceControlPolicyResource> {

    public static enumerateServiceControlBindings(template: TemplateRoot, state: PersistedState): ServiceControlPolicyBinding[] {
        return Binding.enumerateBindings<ServiceControlPolicyResource>(
            OrgResourceTypes.ServiceControlPolicy,
            template.organizationSection.serviceControlPolicies,
            state);

    }
}
