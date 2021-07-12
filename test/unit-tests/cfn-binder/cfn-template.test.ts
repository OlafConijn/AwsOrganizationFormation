import { CfnTemplate } from '~cfn-binder/cfn-template';
import { CloudFormationResource } from '~parser/model/cloudformation-resource';
import { IResourceTarget } from '~parser/model/resources-section';
import { TemplateRoot } from '~parser/parser';
import { PersistedState } from '~state/persisted-state';
import { ConsoleUtil } from '~util/console-util';
import { TestTemplates } from '../test-templates';


describe('when creating cloudformation with simple resource', () => {
    let template: CfnTemplate;
    let templateRoot: TemplateRoot;
    let persistedState: PersistedState;
    let target: IResourceTarget;
    let templateForTarget: string;

    beforeEach(async () => {
        templateRoot = TestTemplates.createBasicTemplate();
        persistedState = PersistedState.CreateEmpty(templateRoot.organizationSection.masterAccount.accountId);

        target = {
            region: 'eu-central-1',
            accountLogicalId: templateRoot.organizationSection.accounts[0].logicalId,
            resources: [
                new CloudFormationResource(templateRoot, 'bucket',
                    {
                        Type: 'AWS::S3::Bucket',
                        Properties: {
                            BucketName: 'BucketName',
                        },
                        OrganizationBinding: {
                            Account: '*',
                            Region: 'eu-central-1'
                        },
                    }),
            ],
        };

        template = new CfnTemplate(target, templateRoot, persistedState);
        templateForTarget = template.createTemplateBody();
    });

    test('returns template body', () => {
        expect(templateForTarget).toBeDefined();
    });

    test('template contains resource', () => {
        const result = JSON.parse(templateForTarget);
        expect(result).toBeDefined();
        expect(result.Resources).toBeDefined();
        expect(result.Resources.bucket).toBeDefined();
        expect(result.Resources.bucket.Type).toBe('AWS::S3::Bucket');
        expect(result.Resources.bucket.Properties).toBeDefined();
        expect(result.Resources.bucket.Properties.BucketName).toBe('BucketName');
    });

    test('template contains version', () => {
        const result = JSON.parse(templateForTarget);
        expect(result.AWSTemplateFormatVersion).toBe('2010-09-09');
    });

    test('template resource doesnt contain organization binding', () => {
        const result = JSON.parse(templateForTarget);
        expect(result).toBeDefined();
        expect(result.Resources).toBeDefined();
        expect(result.Resources.bucket).toBeDefined();
        expect(result.Resources.bucket.OrganizationBinding).toBeUndefined();
    });

});

describe('when creating cloudformation with resource that has version attribute', () => {
    let template: CfnTemplate;
    let templateRoot: TemplateRoot;
    let persistedState: PersistedState;
    let target: IResourceTarget;
    let templateForTarget: string;

    beforeEach(async () => {
        templateRoot = TestTemplates.createBasicTemplate();
        persistedState = PersistedState.CreateEmpty(templateRoot.organizationSection.masterAccount.accountId);

        target = {
            region: 'eu-central-1',
            accountLogicalId: templateRoot.organizationSection.accounts[0].logicalId,
            resources: [
                new CloudFormationResource(templateRoot, 'BucketPolicy',
                    {
                        Type: 'AWS::S3::BucketPolicy',
                        Properties: {
                            Bucket: 'Bucket',
                            PolicyDocument: {
                              Version: '2012-10-17T00:00:00.000Z',
                            },
                        },
                        OrganizationBinding: {
                            Account: '*',
                            Region: 'eu-central-1'
                        },
                    }),
            ],
        };

        template = new CfnTemplate(target, templateRoot, persistedState);
        templateForTarget = template.createTemplateBody();
    });

    test('resource contains version in cfn format', () => {
        const result = JSON.parse(templateForTarget);
        expect(result.Resources.BucketPolicy).toBeDefined();
        expect(result.Resources.BucketPolicy.Properties.PolicyDocument.Version).toBeDefined();
        expect(result.Resources.BucketPolicy.Properties.PolicyDocument.Version).toBe('2012-10-17');
    });
});

describe('when creating cloudformation with output section', () => {
    let template: CfnTemplate;
    let templateRoot: TemplateRoot;
    let persistedState: PersistedState;
    let target: IResourceTarget;
    let templateForTarget: string;

    beforeEach(async () => {
        templateRoot = TestTemplates.createBasicTemplate();
        persistedState = PersistedState.CreateEmpty(templateRoot.organizationSection.masterAccount.accountId);

        target = {
            region: 'eu-central-1',
            accountLogicalId: templateRoot.organizationSection.accounts[0].logicalId,
            resources: [
                new CloudFormationResource(templateRoot, 'bucket',
                    {
                        Type: 'AWS::S3::Bucket',
                        Properties: {
                            BucketName: 'BucketName',
                        },
                        OrganizationBinding: {
                            Account: '*',
                            Region: 'eu-central-1',
                        },
                    }),
            ],
        };

        templateRoot.resourcesSection.resources.push(target.resources[0]);
        templateRoot.resourcesSection.resources.push(new CloudFormationResource(templateRoot, 'bucket2', {Type: 'abcdef', OrganizationBinding: { Region: 'eu-central-1'}}));

        templateRoot.contents.Outputs = {
            Output : {
                Value: {Ref: 'bucket'},
            },
            OutputRefOtherTarget: {
                Value: {Ref: 'bucket2'},
            },
            Output2 : {
                Value: {'Fn::GetAtt': ['AWSAccount', 'Resources.bucket']},
            },
            OutputRefOtherTarget2: {
                Value: {'Fn::GetAtt': ['AWSAccount', 'Resources.bucket2']},
            },
            OutputGetAttOtherTarget: {
                Value: {'Fn::GetAtt': ['bucket2', 'bucketName']},
            },
            OutputGetOrgFunctions: {
                Value:  {'Fn::GetAtt': ['AWSAccount', 'AccountName']},
            },
            OutputTag : {
                Value: {'Fn::GetAtt': ['AWSAccount', 'Tags.key.other']},
            },
        };
        template = new CfnTemplate(target, templateRoot, persistedState);
        templateForTarget = template.createTemplateBody();
    });

    test('template contains output in same target', () => {
        const result = JSON.parse(templateForTarget);
        expect(result).toBeDefined();
        expect(result.Outputs).toBeDefined();
        expect(result.Outputs.Output.Value.Ref).toBe('bucket');
    });

    test('template contains output in same target using AWSAccount.Resources syntax', () => {
        const result = JSON.parse(templateForTarget);
        expect(result).toBeDefined();
        expect(result.Outputs).toBeDefined();
        expect(result.Outputs.Output2.Value.Ref).toBe('bucket');
    });

    test('output to Ref in other target is removed', () => {
        const result = JSON.parse(templateForTarget);
        expect(result).toBeDefined();
        expect(result.Outputs).toBeDefined();
        expect(result.Outputs.OutputRefOtherTarget).toBeUndefined();
    });

    test('output to Ref in other target is removed using AWSAccount.Resources syntax', () => {
        ConsoleUtil.LogWarning('TODO: fix, see issue: https://github.com/org-formation/org-formation-cli/issues/119');
        // const result = JSON.parse(templateForTarget);
        // expect(result).toBeDefined();
        // expect(result.Outputs).toBeDefined();
        // expect(result.Outputs.OutputRefOtherTarget2).toBeUndefined();
    });

    test('output to GetAtt in other target is removed', () => {
        const result = JSON.parse(templateForTarget);
        expect(result).toBeDefined();
        expect(result.Outputs).toBeDefined();
        expect(result.Outputs.OutputGetAttOtherTarget).toBeUndefined();
    });

    test('output to Org function is resolved', () => {
        const result = JSON.parse(templateForTarget);
        expect(result).toBeDefined();
        expect(result.Outputs).toBeDefined();
        expect(result.Outputs.OutputGetOrgFunctions).toBeDefined();
        expect(result.Outputs.OutputGetOrgFunctions.Value).toBe('My Account 1');
    });

    test('complex tag key will get resolved', () => {
        const result = JSON.parse(templateForTarget);
        expect(result).toBeDefined();
        expect(result.Outputs).toBeDefined();
        expect(result.Outputs.OutputTag).toBeDefined();
        expect(result.Outputs.OutputTag.Value).toBe('val');
    });
});

describe('when creating cross account reference', () => {
    let template: CfnTemplate;
    let templateRoot: TemplateRoot;
    let persistedState: PersistedState;
    let target: IResourceTarget;
    let templateForTarget: string;

    beforeEach(async () => {
        templateRoot = TestTemplates.createBasicTemplate();
        persistedState = PersistedState.CreateEmpty(templateRoot.organizationSection.masterAccount.accountId);

        const account1 = templateRoot.organizationSection.accounts[0].logicalId;
        const account2 = templateRoot.organizationSection.accounts[1].logicalId;

        target = {
            region: 'eu-central-1',
            accountLogicalId: account1,
            resources: [
                new CloudFormationResource(templateRoot, 'bucket',
                    {
                        Type: 'AWS::S3::Bucket',
                        Properties: {
                            BucketName: { Ref : 'bucket2' },
                        },
                        OrganizationBinding: {
                            Account: { Ref: account1 },
                            Region: 'eu-central-1',
                        },
                    }),
            ],
        };

        const other = new CloudFormationResource(templateRoot, 'bucket2',
            {
                Type: 'abcdef',
                OrganizationBinding: {
                    Account: {
                        Ref: account2,
                    },
                    Region: 'eu-central-1',
                },
            });

        templateRoot.resourcesSection.resources.push(target.resources[0]);
        templateRoot.resourcesSection.resources.push(other);

        template = new CfnTemplate(target, templateRoot, persistedState);
        templateForTarget = template.createTemplateBody();
    });

    test('parameter was added to template', () => {
        const result = JSON.parse(templateForTarget);
        expect(result).toBeDefined();
        expect(result.Parameters).toBeDefined();
    });

});
