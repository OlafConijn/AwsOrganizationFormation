import {
    IAccountProperties,
    IOrganizationalUnitProperties,
    IOrganizationRootProperties,
    IServiceControlPolicyProperties,
    OrgResourceTypes,
} from '~parser/model';
import { IResource, IResources, ITemplate, TemplateRoot } from '~parser/parser';
import { PersistedState } from '~state/persisted-state';

export class TestTemplates {

    public static createState(template: TemplateRoot): PersistedState {
        const master = template.organizationSection.masterAccount;
        const state = PersistedState.CreateEmpty(master.accountId);
        state.setBinding({
            type: master.type,
            logicalId: master.logicalId,
            physicalId: master.accountId,
            lastCommittedHash: 'asd',
        });

        for (const acc of template.organizationSection.accounts) {
            state.setBinding({
                type: acc.type,
                logicalId: acc.logicalId,
                physicalId: acc.accountId,
                lastCommittedHash: 'asd',
            });
        }
        for (const ou of template.organizationSection.organizationalUnits) {
            state.setBinding({
                type: ou.type,
                logicalId: ou.logicalId,
                physicalId: `physical-${ou.logicalId}`,
                lastCommittedHash: 'asd',
            });
        }
        for (const scp of template.organizationSection.serviceControlPolicies) {
            state.setBinding({
                type: scp.type,
                logicalId: scp.logicalId,
                physicalId: `physical-${scp.logicalId}`,
                lastCommittedHash: 'asd',
            });
        }
        return state;
    }

    public static createBasicTemplate(resources?: IResources): TemplateRoot {
        const template: ITemplate  = {
            AWSTemplateFormatVersion: '2010-09-09-OC',
            DefaultOrganizationBinding : {
                Account: [{Ref: 'Account'}],
            },
            Organization: {
                MasterAccount: {
                    Type: OrgResourceTypes.MasterAccount,
                    Properties: {
                        AccountId: '1232342341234',
                        AccountName: 'My Master Account',
                        RootEmail: 'master-account@myorg.com',
                        Tags: {
                            key: 'Value 123',
                        },
                    } as IAccountProperties,
                },
                Account: {
                    Type: OrgResourceTypes.Account,
                    Properties: {
                        AccountName: 'My Account 1',
                        RootEmail: 'account-1@myorg.com',
                        AccountId: '1232342341235',
                        Tags: {
                            key: 'Value 234',
                            'key.other': 'val',
                        },
                    } as IAccountProperties,
                },
                Account2: {
                    Type: OrgResourceTypes.Account,
                    Properties: {
                        AccountName: 'My Account 2',
                        RootEmail: 'account-2@myorg.com',
                        AccountId: '1232342341236',
                        Alias: 'account-2',
                        Tags: {
                            key: 'Value 567',
                        },
                    } as IAccountProperties,
                },
                Root: {
                    Type: OrgResourceTypes.OrganizationRoot,
                    Properties: {
                        ServiceControlPolicies: { Ref: 'Policy'},
                    } as IOrganizationRootProperties,
                },
                OU: {
                    Type: OrgResourceTypes.OrganizationalUnit,
                    Properties: {
                        OrganizationalUnitName: 'ou1',
                        ServiceControlPolicies: { Ref: 'Policy'},
                        Accounts: { Ref: 'Account'},
                    } as IOrganizationalUnitProperties,
                },
                OU2: {
                    Type: OrgResourceTypes.OrganizationalUnit,
                    Properties: {
                        OrganizationalUnitName: 'ou2',
                        ServiceControlPolicies: [{ Ref: 'Policy'}, { Ref: 'Policy2'}],
                        Accounts: [{ Ref: 'Account2'}],
                    } as IOrganizationalUnitProperties,
                },
                Policy: {
                    Type : OrgResourceTypes.ServiceControlPolicy,
                    Properties: {
                        PolicyName: 'policy1',
                        PolicyDocument: 'policy document',
                    } as IServiceControlPolicyProperties,
                },
                Policy2: {
                    Type : OrgResourceTypes.ServiceControlPolicy,
                    Properties: {
                        PolicyName: 'policy2',
                        PolicyDocument: 'policy document',
                    } as IServiceControlPolicyProperties,
                },
            },
            Resources: resources,
        };

        return new TemplateRoot(template, './');
    }
}
