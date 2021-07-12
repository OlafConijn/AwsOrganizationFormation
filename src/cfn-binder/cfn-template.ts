import { dump as yamlDump } from 'js-yaml';
import { ConsoleUtil } from '../util/console-util';
import { OrgFormationError } from '../org-formation-error';
import { ResourceUtil } from '../util/resource-util';
import { ICfnBinding, ICfnCrossAccountDependency } from './cfn-binder';
import { SubExpression } from './cfn-sub-expression';
import {
    AccountResource,
    IResourceTarget,
} from '~parser/model';
import { ITemplate, TemplateRoot } from '~parser/parser';
import { PersistedState } from '~state/persisted-state';
import { ICfnExpression } from '~core/cfn-expression';
import { CfnExpressionResolver } from '~core/cfn-expression-resolver';
import { CfnFunctions, ICfnFunctionContext } from '~core/cfn-functions/cfn-functions';

export class CfnTemplate {

    private static CreateCrossAccountReferenceForRef(target: ICfnBinding, resourceLogicalId: string, accountLogicalId?: string): ICfnCrossAccountReference {
        const result: ICfnCrossAccountReference = {
            accountId: target.accountId,
            stackName: target.stackName,
            region: target.region,
            referenceType: 'Ref',
            resourceLogicalId,
            valueType: 'String',
            path: undefined,
            uniqueNameForExport: `${target.stackName}-${resourceLogicalId}`,
            expressionForExport: { Ref: resourceLogicalId },
            uniqueNameForImport: resourceLogicalId,
        };
        const resource = target.template!.resources[resourceLogicalId];
        if (resource.Condition !== undefined) {
            result.conditionForExport = resource.Condition;
        }

        if (accountLogicalId) {
            const accountLogicalWithDashes = accountLogicalId.replace(/\-/g, 'Dash');
            result.uniqueNameForImport = accountLogicalWithDashes + 'DotResourcesDot' + result.uniqueNameForImport;
        }
        return result;
    }

    private static CreateCrossAccountReferenceForGetAtt(target: ICfnBinding, resourceLogicalId: string, path: string, accountLogicalId?: string): ICfnCrossAccountReference {
        const result: ICfnCrossAccountReference = {
            accountId: target.accountId,
            stackName: target.stackName,
            region: target.region,
            referenceType: 'GetAtt',
            resourceLogicalId,
            valueType: 'String',
            path,
            uniqueNameForExport: `${target.stackName}-${resourceLogicalId}-${path}`.replace(/\./g, 'Dot'),
            expressionForExport: { 'Fn::GetAtt': [resourceLogicalId, path] },
            uniqueNameForImport: (resourceLogicalId + 'Dot' + path).replace(/\./g, 'Dot'),
        };
        const resource = target.template!.resources[resourceLogicalId];
        if (accountLogicalId) {
            const accountLogicalWithDashes = accountLogicalId.replace(/\-/g, 'Dash');
            result.uniqueNameForImport = accountLogicalWithDashes + 'DotResourcesDot' + result.uniqueNameForImport;
        }
        if (resource.Condition !== undefined) {
            result.conditionForExport = resource.Condition;
        }
        if (path && (path.endsWith('NameServers') || path.endsWith('DnsEntries'))) { // todo: add list of other attributes that are not string;
            result.valueType = 'CommaDelimitedList';
            result.expressionForExport = { 'Fn::Join': [', ', { 'Fn::GetAtt': [resourceLogicalId, path] }] };
        }

        return result;
    }

    private static CreateDependency(source: ICfnBinding, target: ICfnCrossAccountReference): ICfnCrossAccountDependency {
        return {
            parameterAccountId: source.accountId,
            parameterRegion: source.region,
            parameterStackName: source.stackName,
            parameterType: target.valueType,
            parameterName: target.uniqueNameForImport,
            outputAccountId: target.accountId,
            outputRegion: target.region,
            outputStackName: target.stackName,
            outputName: target.uniqueNameForExport,
            outputValueExpression: target.expressionForExport,
            outputCondition: target.conditionForExport,
        };
    }

    private resultingTemplate: ITemplate;
    private resources: Record<string, any>;
    private outputs: Record<string, ICfnOutput>;
    private parameters: Record<string, ICfnParameter>;
    private resourceIdsForTarget: string[];
    private allResourceIds: string[];
    private resourceIdsNotInTarget: string[];
    private otherAccountsLogicalIds: string[];
    private accountResource: AccountResource;
    private resolverContext: ICfnFunctionContext;
    private masterAccountLogicalId: string;

    constructor(target: IResourceTarget, private templateRoot: TemplateRoot, private state: PersistedState) {
        this.resourceIdsForTarget = target.resources.map(x => x.logicalId);
        this.allResourceIds = this.templateRoot.resourcesSection.resources.map(x => x.logicalId);
        this.resourceIdsNotInTarget = this.allResourceIds.filter(x => !this.resourceIdsForTarget.includes(x));
        this.accountResource = this.templateRoot.organizationSection.findAccount(x => x.logicalId === target.accountLogicalId);
        this.otherAccountsLogicalIds = [this.templateRoot.organizationSection.masterAccount.logicalId, ...this.templateRoot.organizationSection.accounts.map(x => x.logicalId).filter(x => x !== target.accountLogicalId)];
        this.masterAccountLogicalId = this.templateRoot.organizationSection.masterAccount.logicalId;

        this.resources = {};
        this.outputs = {};
        this.parameters = {};

        this.resultingTemplate = {
            AWSTemplateFormatVersion: '2010-09-09',
            Description: this.templateRoot.contents.Description,
            Parameters: this.parameters,
            Resources: this.resources,
            Outputs: this.outputs,
        };

        this.resolverContext = { finalPass: false, filePath: this.templateRoot.filepath, mappings: {} };


        for (const resource of target.resources) {
            const clonedResource = JSON.parse(JSON.stringify(resource.resourceForTemplate));
            ResourceUtil.FixVersions(clonedResource);
            this._removeCrossAccountDependsOn(clonedResource, this.resourceIdsForTarget, this.allResourceIds);
            if (resource.normalizedForeachAccounts) {
                for (const accountName of resource.normalizedForeachAccounts) {
                    const resourceForAccount = JSON.parse(JSON.stringify(resource.resourceForTemplate));
                    const keywordReplaced = this._replaceKeyword(resourceForAccount, 'CurrentAccount', accountName);

                    const binding = this.state.getAccountBinding(accountName);
                    if (!binding) { throw new OrgFormationError(`unable to find account ${accountName} in state. Is your organization up to date?`); }

                    this.resources[resource.logicalId + binding.physicalId] = this._resolveOrganizationFunctionsAndStructuralFunctions(keywordReplaced, this.accountResource);
                }
            } else {
                this.resources[resource.logicalId] = this._resolveOrganizationFunctionsAndStructuralFunctions(clonedResource, this.accountResource);
            }
        }

        const outputs = this.templateRoot.contents.Outputs;
        if (outputs !== undefined) {
            const clonedOutputs = JSON.parse(JSON.stringify(outputs));
            const resolvedOutput = this._resolveOrganizationFunctionsAndStructuralFunctions(clonedOutputs, this.accountResource);
            for (const outputName in outputs) {

                const hasExpressionsToResourcesOutsideTarget = ResourceUtil.HasExpressions(resolvedOutput, outputName, this.resourceIdsNotInTarget);
                if (!hasExpressionsToResourcesOutsideTarget) {
                    this.outputs[outputName] = resolvedOutput[outputName];
                }
            }
        }

        for (const paramName in this.templateRoot.contents.Parameters) {
            const param = this.templateRoot.contents.Parameters[paramName];
            const clonedParam = JSON.parse(JSON.stringify(param));
            const parameter = this._resolveOrganizationFunctionsAndStructuralFunctions(clonedParam, this.accountResource) as ICfnParameter;
            if (parameter.ExportAccountId) {
                const val = (parameter.ExportAccountId as any).Ref;
                if (val !== undefined) {
                    throw new OrgFormationError(`unable to resolve !Ref ${val} for cross account parameter.`);
                }
            }
            this.parameters[paramName] = parameter;
        }

        if (this.templateRoot.contents.Metadata) {
            const clonedMetadata = JSON.parse(JSON.stringify(this.templateRoot.contents.Metadata));
            this.resultingTemplate.Metadata = this._resolveOrganizationFunctionsAndStructuralFunctions(clonedMetadata, this.accountResource);

        }
        if (this.templateRoot.contents.Conditions) {
            const clonedConditions = JSON.parse(JSON.stringify(this.templateRoot.contents.Conditions));
            this.resultingTemplate.Conditions = this._resolveOrganizationFunctionsAndStructuralFunctions(clonedConditions, this.accountResource);
        }

        if (this.templateRoot.contents.Mappings) {
            const clonedMappings = JSON.parse(JSON.stringify(this.templateRoot.contents.Mappings));
            this.resultingTemplate.Mappings = this._resolveOrganizationFunctionsAndStructuralFunctions(clonedMappings, this.accountResource);
        }

        if (this.templateRoot.contents.Globals) {
            const clonedGlobals = JSON.parse(JSON.stringify(this.templateRoot.contents.Globals));
            this.resultingTemplate.Globals = this._resolveOrganizationFunctionsAndStructuralFunctions(clonedGlobals, this.accountResource);
        }

        if (this.templateRoot.contents.Transform) {
            this.resultingTemplate.Transform = this.templateRoot.contents.Transform;
        }
    }

    public listDependencies(binding: ICfnBinding, others: ICfnBinding[]): ICfnCrossAccountDependency[] {

        const result: ICfnCrossAccountDependency[] = [];
        for (const logicalId in this.resources) {
            const resource = this.resources[logicalId];
            const foundDependencies = this._listDependencies(resource, binding, others);
            if (foundDependencies.length > 0) {
                result.push(...foundDependencies);
            }
        }
        return result;
    }

    public addOutput(dependency: ICfnCrossAccountDependency): void {
        const cfnFriendlyName = dependency.outputName.replace(/-/g, 'Dash');

        if (!this.outputs[cfnFriendlyName]) {
            this.outputs[cfnFriendlyName] = {
                Value: dependency.outputValueExpression,
                Condition: dependency.outputCondition,
                Description: 'Cross Account dependency',
                Export: {
                    Name: dependency.outputName,
                },
            };
        }
    }

    public addParameter(dependency: ICfnCrossAccountDependency): void {
        if (!this.parameters[dependency.parameterName]) {
            this.parameters[dependency.parameterName] = {
                Description: 'Cross Account dependency',
                Type: dependency.parameterType,
                ExportAccountId: dependency.outputAccountId,
                ExportRegion: dependency.outputRegion,
                ExportName: dependency.outputName,
            };
        }
    }

    public enumBoundParameters(): Record<string, ICfnParameter> {
        const parameters: Record<string, ICfnParameter> = {};
        for (const paramName in this.parameters) {
            const parameter = this.parameters[paramName];
            if (parameter.ExportName) {
                parameters[paramName] = parameter;
            }
        }
        return parameters;
    }

    public createTemplateBody(options: ITemplateGenerationOptions = { output: 'json', outputCrossAccountExports: true }): string {
        const replacer = (k: string, val: any): any => {
            if (k === 'ExportAccountId' || k === 'ExportName' || k === 'ExportRegion') {
                return undefined;
            }
            return val;
        };

        const template = JSON.parse(JSON.stringify(this.resultingTemplate, options.outputCrossAccountExports ? undefined : replacer));
        if (options.output === 'json') {
            return JSON.stringify(template, null, 2);
        } else {
            return yamlDump(template);
        }
    }

    public async createTemplateBodyAndResolve(expressionResolver: CfnExpressionResolver, addBogusTransform = false): Promise<string> {
        const template = { ... this.resultingTemplate } as ITemplate;
        template.Description = await expressionResolver.resolveSingleExpression(template.Description, 'Description');
        if (addBogusTransform && template.Transform === undefined) {
            template.Transform = 'bogus-transform-to-allow-custom-types-to-pass-validation';
        }
        return JSON.stringify(template, null, 2);
    }

    private _removeCrossAccountDependsOn(resource: any, resourceIdsForTarget: string[], allResourceIds: string[]): void {

        if (resource !== null && typeof resource === 'object') {
            const dependsOnType = typeof resource.DependsOn;
            if (dependsOnType === 'string') {
                resource.DependsOn = [resource.DependsOn];
            }
            if (resource.DependsOn !== null && Array.isArray(resource.DependsOn)) {
                const dependsOn = resource.DependsOn as string[];
                const unresolvedDependency = dependsOn.find(x => !allResourceIds.includes(x));
                if (unresolvedDependency) {
                    throw new OrgFormationError(`Dependent resource ${unresolvedDependency} could not be resolved`);
                }

                resource.DependsOn = dependsOn.filter(x => resourceIdsForTarget.includes(x));
            }
            if (dependsOnType === 'string' && resource.DependsOn.length === 1) {
                resource.DependsOn = resource.DependsOn[0];
            }
        }
    }

    private _listDependencies(resource: any, binding: ICfnBinding, others: ICfnBinding[]): ICfnCrossAccountDependency[] {
        const result: ICfnCrossAccountDependency[] = [];

        const expressionsToOtherAccounts = ResourceUtil.EnumExpressionsForResource(resource, [...this.otherAccountsLogicalIds, this.accountResource.logicalId]);
        for (const expression of expressionsToOtherAccounts) {
            const otherAccount = this.templateRoot.organizationSection.findAccount(x => x.logicalId === expression.resource);

            // OtherAccount.Resources.LogicalResourceName[.Arn]?
            if (expression.path && expression.path.startsWith('Resources.')) {
                const remoteExpression = expression.path.substring(10);
                let remoteResource: string;
                let remotePath: string;

                if (remoteExpression.includes('.')) {
                    const allParts = remoteExpression.split('.');
                    remotePath = allParts.splice(1).join('.');
                    remoteResource = allParts[0];
                } else {
                    remoteResource = remoteExpression;
                }

                const bindingForResource = this.resolveBindingForResourceSpecificAccount(otherAccount, remoteResource, others);
                if (bindingForResource === undefined) { throw new OrgFormationError(`unable to find resource ${remoteResource} on account ${otherAccount}`); }

                const reference = remotePath ?
                    CfnTemplate.CreateCrossAccountReferenceForGetAtt(bindingForResource, remoteResource, remotePath, otherAccount.logicalId) :
                    CfnTemplate.CreateCrossAccountReferenceForRef(bindingForResource, remoteResource, otherAccount.logicalId);

                const dependency = CfnTemplate.CreateDependency(binding, reference);

                result.push(dependency);
                expression.rewriteExpression(dependency.parameterName);
            }
        }

        const expressionsToResourcesInOtherAccounts = ResourceUtil.EnumExpressionsForResource(resource, this.resourceIdsNotInTarget);
        for (const expression of expressionsToResourcesInOtherAccounts) {

            // LogicalResourceName[.Arn]?
            const bindingForResource = this.resolveBindingForResource(others, expression.resource);

            const reference = expression.path ?
                CfnTemplate.CreateCrossAccountReferenceForGetAtt(bindingForResource, expression.resource, expression.path) :
                CfnTemplate.CreateCrossAccountReferenceForRef(bindingForResource, expression.resource);

            const dependency = CfnTemplate.CreateDependency(binding, reference);

            result.push(dependency);
            expression.rewriteExpression(dependency.parameterName);

        }
        return result;
    }

    private _replaceKeyword(resource: any, keyword: string, replacement: string): void {
        const expressions = ResourceUtil.EnumExpressionsForResource(resource, [keyword]);
        for (const expression of expressions) {
            expression.rewriteExpression(replacement, expression.path);
        }
        return resource;
    }


    private _resolveOrganizationFunctionsAndStructuralFunctions(resource: any, account: AccountResource): any {
        const resolved = this._resolveOrganizationFunctions(resource, account);

        return CfnFunctions.resolveTreeStructural(this.resolverContext, false, resolved);
    }

    private _resolveOrganizationFunctions(resource: any, account: AccountResource): any {
        const expressionsToSelf = ResourceUtil.EnumExpressionsForResource(resource, [account.logicalId, 'AWSAccount']);
        for (const expression of expressionsToSelf) {
            // AWSAccount[.Alias]?
            const val = this.resolveAccountGetAtt(account, expression.path);
            if (val !== undefined) {
                expression.resolveToValue(val);
                continue;
            }

            // AWSAccount.Resources.LogicalRsourceId[.Arn]?
            if (expression.path && expression.path.startsWith('Resources.')) {
                const localExpression = expression.path.substring(10);
                if (localExpression.includes('.')) {
                    const allParts = localExpression.split('.');
                    const path = allParts.splice(1).join('.');
                    if (this.resourceIdsForTarget.includes(allParts[0])) {
                        expression.rewriteExpression(allParts[0], path);
                        continue;
                    }
                } else {
                    if (this.resourceIdsForTarget.includes(localExpression)) {
                        expression.rewriteExpression(localExpression);
                        continue;
                    }
                }

                expression.rewriteExpression(account.logicalId, expression.path);
            }
        }

        const expressionsToOtherAccounts = ResourceUtil.EnumExpressionsForResource(resource, [...this.otherAccountsLogicalIds]);
        for (const expression of expressionsToOtherAccounts) {
            const otherAccount = this.templateRoot.organizationSection.findAccount(x => x.logicalId === expression.resource);

            const val = this.resolveAccountGetAtt(otherAccount, expression.path);

            // OtherAccount[.Alias]?
            if (val !== undefined) {
                expression.resolveToValue(val);
                continue;
            }
        }

        if (resource !== null && typeof resource === 'object') {
            const entries = Object.entries(resource);

            for (const [key, val] of entries) {
                if (val !== null && typeof val === 'object') {
                    resource[key] = this._resolveOrganizationFunctions(val, account);
                }

                if (val !== null && typeof val === 'string') {
                    if (val.startsWith('Fn::EnumTargetAccounts ')) {
                        const result = this.resolveEnumExpression('EnumTargetAccounts', val, 'account');
                        resource = CfnTemplate.replaceEnumExpressionWithResults(resource, key, val, result);
                    } else if (val.startsWith('Fn::EnumTargetRegions')) {
                        const result = this.resolveEnumExpression('EnumTargetRegions', val, 'region');
                        resource = CfnTemplate.replaceEnumExpressionWithResults(resource, key, val, result);
                    } else if (val.startsWith('Fn:TargetCount')) {
                        ConsoleUtil.LogWarning('expression references Fn::TargetCount with 1 colon (:) instead of two.');
                        resource[key] = this.resolveCountExpression(val);
                    } else if (val.startsWith('Fn::TargetCount')) {
                        resource[key] = this.resolveCountExpression(val);

                    }
                }
            }
        }
        return resource;
    }

    private static replaceEnumExpressionWithResults(resource: any, key: any, val: any, expressionResult: any): void {
        if (Array.isArray(resource)) {
            const index = resource.indexOf(val);
            if (Array.isArray(expressionResult)) {
                resource.splice(index, 1, ...expressionResult);
            } else {
                resource[index] = expressionResult;
            }
        } else {
            resource[key] = expressionResult;
        }
        return resource;
    }

    private resolveBindingForResourceSpecificAccount(account: AccountResource, resourceLogicalId: string, others: ICfnBinding[]): ICfnBinding {
        const otherAccountState = this.state.getBinding(account.type, account.logicalId);
        if (!otherAccountState) { throw new OrgFormationError(`unable to find account ${account.logicalId} in state. Is your organization up to date?`); }

        const foundBinding = others.
            filter(x => x.accountId === otherAccountState.physicalId).
            filter(x => x.template!.resources[resourceLogicalId]);

        if (foundBinding.length === 0) {
            ConsoleUtil.LogWarning(`Unable to find resource ${resourceLogicalId} on account ${account.logicalId}`);
            return undefined;
        }
        if (foundBinding.length > 1) {
            const list = foundBinding.map(x => `${x.accountId}/${x.region}`).join(', ');
            throw new OrgFormationError(`Found multiple targets for reference to ${account.logicalId} ${resourceLogicalId}. e.g: ${list}`);
        }
        return foundBinding[0];
    }

    private resolveBindingForResource(bindings: ICfnBinding[], resourceLogicalId: string): ICfnBinding {
        const foundBinding = bindings.filter(x => x.template!.resources[resourceLogicalId]);
        if (foundBinding.length === 0) {
            ConsoleUtil.LogDebug(`Unable to find resource with logicalId ${resourceLogicalId}.`);
            return undefined;
        }
        if (foundBinding.length > 1) {
            const list = foundBinding.map(x => `${x.accountId}/${x.region}`).join(', ');
            throw new OrgFormationError(`Found multiple targets for reference to ${resourceLogicalId}. e.g: ${list}`);
        }
        return foundBinding[0];
    }
    private resolveCountExpression(val: string): number {
        const parts = val.split(/\s+/);
        if (parts.length < 2) {
            throw new OrgFormationError('invalid Fn::TargetCount expression. expected \'Fn::TargetCount bindingName\'');
        }
        const bindingId = parts[1];
        const organizationBinding = this.templateRoot.bindingSection.getBinding(bindingId);

        const numTemplates = this.templateRoot.resolveNormalizedLogicalAccountIds(organizationBinding).length;
        const numRegions = this.templateRoot.resolveNormalizedRegions(organizationBinding).length;

        return numRegions * numTemplates;

    }
    private resolveEnumExpression(which: 'EnumTargetAccounts' | 'EnumTargetRegions', val: string, replacementParameter: string): any[] {
        const value = val.trim();
        let expr: string;
        let bindingId: string;

        if (value.endsWith('\'')) {
            const firstIndex = value.indexOf('\'');
            if (firstIndex === value.length) { throw new OrgFormationError(`invalid ${which} expression ${value}. missing a qoute?`); }
            expr = value.substring(firstIndex + 1, value.length - 1);
            const parts = val.split(/\s+/);
            if (!parts[1].startsWith('\'')) {
                bindingId = parts[1];
            }
        } else {
            const parts = val.split(/\s+/);
            if (parts.length === 2) {
                expr = parts[1];
            } else if (parts.length === 3) {
                bindingId = parts[1];
                expr = parts[2];
            } else {
                throw new OrgFormationError(`invalid ${which} expression ${parts.slice(1)}. if you need to use spaces in your expression wrap this in single qoutes`);
            }
        }
        const organizationBinding = bindingId !== undefined ?
            this.templateRoot.bindingSection.getBinding(bindingId) :
            this.templateRoot.bindingSection.defaultBinding;
        const enumUnderlyingValues = [];
        if (which === 'EnumTargetAccounts') {
            const normalizedLogicalAccountIds = this.templateRoot.resolveNormalizedLogicalAccountIds(organizationBinding);
            for (const logicalAccountId of normalizedLogicalAccountIds) {
                const otherAccount = this.templateRoot.organizationSection.findAccount(x => x.logicalId === logicalAccountId);
                const physicalId = this.resolveAccountGetAtt(otherAccount, 'AccountId');
                enumUnderlyingValues.push(physicalId);
            }
        } else if (which === 'EnumTargetRegions') {
            const normalizedRegions = this.templateRoot.resolveNormalizedRegions(organizationBinding);
            enumUnderlyingValues.push(...normalizedRegions);
        }

        let expression = '${' + replacementParameter + '}';
        if (expr !== undefined) {
            expression = expr;
        }
        const converted = this.convertExpression(enumUnderlyingValues, expression, replacementParameter);
        const result: any[] = [];
        for (const element of converted) {
            if (element.hasVariables()) {
                result.push({ 'Fn::Sub': element.getSubValue() });
            } else {
                result.push(element.getSubValue());
            }
        }
        if (result.length === 1) {
            return result[0];
        }
        return result;
    }

    private convertExpression(values: string[], expression: string, resourceId: string): SubExpression[] {
        const result: SubExpression[] = [];
        for (const val of values) {
            const x = new SubExpression(expression);
            const accountVar = x.variables.find(v => v.resource === resourceId);
            if (accountVar) {
                accountVar.replace(val);
            }
            result.push(x);
        }
        return result;
    }


    private resolveAccountGetAtt(account: AccountResource, path?: string): string | undefined {
        const val = CfnExpressionResolver.ResolveAccountExpression(account, path, this.state);
        if (val !== undefined) {
            return val;
        }
        if (!path.startsWith('Resources.')) {
            throw new OrgFormationError(`unable to resolve account attribute ${account.logicalId}.${path}`);
        }
        return undefined;
    }
}

export interface ICfnParameter {
    Description: string;
    Type: string;
    Default?: string;
    ExportName?: string;
    ExportAccountId?: string;
    ExportRegion?: string;
}
export interface ICfnExport {
    Name: string;
}
export interface ICfnOutput {
    Export: ICfnExport;
    Value: ICfnExpression;
    Description: string;
    Condition: string;
}

interface ICfnCrossAccountReference {
    accountId: string;
    region: string;
    stackName: string;
    resourceLogicalId: string;
    path?: string;
    referenceType: 'GetAtt' | 'Ref';
    valueType: 'String' | 'CommaDelimitedList';
    uniqueNameForExport: string;
    expressionForExport: ICfnExpression;
    uniqueNameForImport: string;
    conditionForExport?: string;
}
interface ITemplateGenerationOptions {
    output: 'json' | 'yaml';
    outputCrossAccountExports: boolean;
}
