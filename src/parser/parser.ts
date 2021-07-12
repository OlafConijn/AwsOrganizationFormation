import * as fs from 'fs';
import md5 = require('md5');
import * as Path from 'path';
import { ConsoleUtil } from '../util/console-util';
import { OrgFormationError } from '../org-formation-error';
import { OrganizationBindingsSection } from './model/organization-bindings-section';
import { OrganizationSection } from './model/organization-section';
import { Reference, Resource } from './model/resource';
import { OrgResourceTypes } from './model/resource-types';
import { ResourcesSection } from './model/resources-section';
import { Validator } from './validator';
import { OrganizationalUnitResource } from './model/organizational-unit-resource';
import { AccountResource } from './model/account-resource';
import { FileUtil } from '~util/file-util';
import { yamlParseContentWithIncludes } from '~yaml-cfn/yaml-parse-includes';
import { nunjucksParseContentWithIncludes } from '~yaml-cfn/nunjucks-parse-includes';

type TemplateVersion = '2010-09-09-OC' | '2010-09-09';

export interface ITemplate {
    AWSTemplateFormatVersion: TemplateVersion;
    Transform?: string;
    StackName?: string;
    Description?: string;
    Organization?: IOrganization;
    OrganizationBindings?: Record<string, IOrganizationBinding>;
    OrganizationBindingRegion?: string | string[]; // old: dont use
    OrganizationBinding?: IOrganizationBinding;  // old: dont use
    DefaultOrganizationBindingRegion?: string | string[];
    DefaultOrganizationBinding?: IOrganizationBinding;
    Metadata?: any;
    Parameters?: any;
    Mappings?: any;
    Globals?: any;
    Conditions?: any;
    Resources?: IResources;
    Outputs?: any;
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export type IResources = IResourcesMap;

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export type IOrganization = IResourcesMap;

export type IResourcesMap = Record<string, IResource>;

export interface IResource {
    Type: OrgResourceTypes | string;
    Properties?: IPropertiesMap;
    OrganizationBinding?: IResourceRefExpression | (IOrganizationBinding & IPropertiesMap);
    Foreach?: IResourceRefExpression | (IOrganizationBinding & IPropertiesMap); // old: do not use
    ForeachAccount?: IResourceRefExpression | (IOrganizationBinding & IPropertiesMap);
    DependsOnAccount?: IResourceRef | IResourceRef[];
    DependsOnRegion?: string | string[];
}

export type IPropertiesMap = Record<string, any>;

export type IResourceRef = IResourceRefExpression | string;

export interface IResourceRefExpression {
    Ref: string;
}

export interface IOrganizationBinding {
    IncludeMasterAccount?: boolean;
    Account?: IResourceRef | IResourceRef[];
    ExcludeAccount?: IResourceRef | IResourceRef[];
    OrganizationalUnit?: IResourceRef | IResourceRef[];
    Region?: string | string[];
    AccountsWithTag?: string;
}

export interface ITemplateOverrides {
    StackName?: string;
    Description?: string;
    OrganizationFile?: string;
    OrganizationFileContents?: string;
    OrganizationBinding?: IOrganizationBinding;
    OrganizationBindingRegion?: string | string[];
    DefaultOrganizationBindingRegion?: string | string[];
    DefaultOrganizationBinding?: IOrganizationBinding;
    OrganizationBindings?: Record<string, IOrganizationBinding>;
    ParameterValues?: Record<string, any>;
    TemplatingContext?: Record<string, any>;
}

export class TemplateRoot {

    public static async create(path: string, overrides: ITemplateOverrides = {}, templateImportContentMd5?: string): Promise<TemplateRoot> {
        try {
            const contents = await FileUtil.GetContents(path);
            const dirname = Path.dirname(path);
            const filename = Path.basename(path);
            return TemplateRoot.createFromContents(contents, dirname, filename, overrides, templateImportContentMd5);
        } catch (err) {
            let reason = 'unknown';
            if (err && err.message) {
                reason = err.message;
            }
            throw new OrgFormationError(`unable to load file ${path}. \nreason: ${reason}.`);
        }
    }

    public static createFromContents(contents: string, dirname = './', filename = 'n/a', overrides: ITemplateOverrides = {}, templateImportContentMd5?: string): TemplateRoot {
        if (contents === undefined) { throw new OrgFormationError('contents is undefined'); }
        if (contents.trim().length === 0) { throw new OrgFormationError('contents is empty'); }
        const organizationInclude = /Organization:\s*!Include\s*(\S*)/.exec(contents);
        let includedOrganization;
        let normalizedContentsForParser = contents;
        if (organizationInclude) {
            if (FileUtil.IsRemoteFile(dirname)) {
                throw new Error('Organization: !Include syntax for templates hosted remotely. Please remove the Organization: !Include attribute and have perform-tasks automatically populate the Organization model.');
            }
            normalizedContentsForParser = normalizedContentsForParser.replace(organizationInclude[0], 'Organization:');
            const includePath = Path.join(dirname, organizationInclude[1]);
            includedOrganization = TemplateRoot.getIncludedOrganization(includePath, templateImportContentMd5);
        } else if (overrides.OrganizationFileContents) {
            includedOrganization = TemplateRoot.getIncludedOrganizationFromContents(overrides.OrganizationFileContents, dirname);
        } else if (overrides.OrganizationFile) {
            includedOrganization = TemplateRoot.getIncludedOrganization(overrides.OrganizationFile, templateImportContentMd5);
        }
        delete overrides.OrganizationFile;
        delete overrides.OrganizationFileContents;

        let obj;
        if (overrides.TemplatingContext) {
            const templatingContext = overrides.TemplatingContext;
            obj = nunjucksParseContentWithIncludes(normalizedContentsForParser, dirname, filename, templatingContext) as ITemplate;
        } else {
            obj = yamlParseContentWithIncludes(normalizedContentsForParser, dirname) as ITemplate;
        }
        delete overrides.TemplatingContext;
        if (includedOrganization && !obj.Organization) {
            obj.Organization = includedOrganization;
        }
        if (overrides.OrganizationBindings) {
            obj.OrganizationBindings = { ...obj.OrganizationBindings, ...overrides.OrganizationBindings };
        }
        delete (obj as any).Definitions;
        delete overrides.OrganizationBindings;

        const paramValues = overrides.ParameterValues;
        delete overrides.ParameterValues;

        const mergedWithOverrides = { ...obj, ...overrides };
        return new TemplateRoot(mergedWithOverrides, dirname, filename, paramValues);

    }

    public static createEmpty(): TemplateRoot {
        return new TemplateRoot({
            AWSTemplateFormatVersion: '2010-09-09-OC',
            Organization: {},
        }, './');
    }

    private static getIncludedOrganization(path: string, templateImportContentMd5?: string): IOrganization {
        const includeContents = fs.readFileSync(path).toString();
        const dir = Path.dirname(path);
        if (templateImportContentMd5) {
            const md5Content = md5(includeContents);
            if (templateImportContentMd5 !== md5Content) {
                throw new OrgFormationError(`Organization include file (${path}) must be the same as used elsewhere in tasks.`);
            }
        }
        return TemplateRoot.getIncludedOrganizationFromContents(includeContents, dir);
    }

    private static getIncludedOrganizationFromContents(contents: string, directory: string): IOrganization {
        const includedTemplate = yamlParseContentWithIncludes(contents, directory) as ITemplate;
        if (!includedTemplate.Organization) {
            throw new OrgFormationError('Organization include file does not contain top level Organization.');
        }
        return includedTemplate.Organization;
    }
    public readonly contents: ITemplate;
    public readonly dirname: string;
    public readonly filename: string;
    public readonly filepath: string;
    public readonly organizationSection: OrganizationSection;
    public readonly defaultOrganizationBinding: IOrganizationBinding;
    public readonly defaultOrganizationBindingRegion: string | string[];
    public readonly resourcesSection: ResourcesSection;
    public readonly bindingSection: OrganizationBindingsSection;
    public readonly source: string;
    public readonly hash: string;
    public readonly paramValues: Record<string, any>;

    constructor(contents: ITemplate, dirname: string, filename?: string, paramValues?: Record<string, any>) {

        Validator.ValidateTemplateRoot(contents);

        this.contents = contents;
        this.dirname = dirname ?? './';
        this.filename = filename ?? 'template.yml';
        this.filepath = Path.resolve(this.dirname, this.filename);
        this.source = JSON.stringify(contents);
        this.hash = md5(this.source);
        if (paramValues !== undefined) {
            this.paramValues = paramValues;
        } else {
            this.paramValues = {};
        }
        if (contents.OrganizationBinding !== undefined) {
            ConsoleUtil.LogWarning(`template ${filename} specifies top level OrganizationBinding which is deprecated. Use DefaultOrganizationBinding instead.`);
            contents.DefaultOrganizationBinding = contents.OrganizationBinding;
            delete contents.OrganizationBinding;
        }
        if (contents.OrganizationBindingRegion !== undefined) {
            ConsoleUtil.LogWarning(`template ${filename} specifies top level OrganizationBindingRegion which is deprecated. Use DefaultOrganizationBinding instead.`);
            contents.DefaultOrganizationBindingRegion = contents.OrganizationBindingRegion;
            delete contents.OrganizationBindingRegion;
        }
        this.defaultOrganizationBindingRegion = contents.DefaultOrganizationBindingRegion;
        this.defaultOrganizationBinding = contents.DefaultOrganizationBinding;
        this.organizationSection = new OrganizationSection(this, contents.Organization);
        this.bindingSection = new OrganizationBindingsSection(this, contents.OrganizationBindings);
        this.resourcesSection = new ResourcesSection(this, contents.Resources);

        this.organizationSection.resolveRefs();
        this.resourcesSection.resolveRefs();
    }
    public clone(): TemplateRoot {
        const clonedContents = JSON.parse(JSON.stringify(this.contents));
        return new TemplateRoot(clonedContents, this.dirname);
    }

    public resolveNormalizedRegions(binding: IOrganizationBinding): string[] {
        if (binding === null || binding === undefined || binding.Region === undefined) {
            return [];
        }

        if (typeof binding.Region === 'string') {
            return [binding.Region];
        }
        return binding.Region;
    }

    public resolveNormalizedLogicalAccountIds(binding: IOrganizationBinding): string[] {
        if (binding === null || binding === undefined) {
            return [];
        }

        this.throwForAccountIDs(binding.Account);
        this.throwForAccountIDs(binding.ExcludeAccount);

        const organizationAccountsAndMaster = [this.organizationSection.masterAccount, ...this.organizationSection.accounts];
        const accounts = this.resolve(binding.Account, binding.Account === '*' ? this.organizationSection.accounts : organizationAccountsAndMaster);
        const excludeAccounts = this.resolve(binding.ExcludeAccount, binding.ExcludeAccount === '*' ? this.organizationSection.accounts : organizationAccountsAndMaster);
        const organizationalUnits = this.resolve(binding.OrganizationalUnit, this.organizationSection.organizationalUnits);

        const accountLogicalIds = accounts.map(x => x.TemplateResource!.logicalId);
        const result = new Set<string>(accountLogicalIds);
        for (const accountsForUnit of this.collectAccountLogicalIdsFromOU(organizationalUnits)) {
            result.add(accountsForUnit);
        }
        if (binding.IncludeMasterAccount) {
            if (this.organizationSection.masterAccount) {
                result.add(this.organizationSection.masterAccount.logicalId);
            } else {
                throw new OrgFormationError('unable to include master account if master account is not part of the template');
            }
        }

        if (binding.AccountsWithTag) {
            const tagToMatch = binding.AccountsWithTag;
            const accountsWithTag = this.organizationSection.findAccounts(x => (x.tags !== undefined) && Object.keys(x.tags).indexOf(tagToMatch) !== -1);
            for (const account of accountsWithTag.map(x => x.logicalId)) {
                result.add(account);
            }
        }

        for (const account of excludeAccounts.map(x => x.TemplateResource!.logicalId)) {
            result.delete(account);
        }

        return [...result];
    }

    public resolveNormalizedAccounts(binding: IOrganizationBinding): AccountResource[] {
        const logicalAccountIds = this.resolveNormalizedLogicalAccountIds(binding);
        return logicalAccountIds.map(x => this.organizationSection.findAccount(a => a.logicalId === x));
    }
    public resolve<T extends Resource>(val: IResourceRef | IResourceRef[] | undefined, list: T[]): Reference<T>[] {
        if (val === undefined) {
            return [];
        }
        if (val === '*') {
            return list.map(x => ({ TemplateResource: x }));
        }
        const results: Reference<T>[] = [];
        if (!Array.isArray(val)) {
            val = [val];
        }
        for (const elm of val) {
            if (typeof elm === 'string' || typeof elm === 'number') {
                throw new Error(`value ${elm} expected to be a reference. did you mean to use !Ref ${elm} instead?`);
            } else if (elm instanceof Object) {
                const ref = (elm as IResourceRefExpression).Ref;
                const foundElm = list.find(x => x.logicalId === ref);
                if (foundElm === undefined) {
                    if (this.paramValues[ref] && this.paramValues[ref].Ref) {
                        const refFromParam = this.paramValues[ref].Ref;
                        const foundElmThroughParam = list.find(x => x.logicalId === refFromParam);
                        if (foundElmThroughParam !== undefined) {
                            results.push({ TemplateResource: foundElmThroughParam });
                        }
                        continue;
                    }

                    if (this.contents.Parameters) {
                        const paramValue = this.contents.Parameters[ref];
                        if (paramValue && paramValue.Default && paramValue.Default.Ref) {
                            const refFromParam = paramValue.Default.Ref;
                            const foundElmThroughParam = list.find(x => x.logicalId === refFromParam);
                            if (foundElmThroughParam !== undefined) {
                                results.push({ TemplateResource: foundElmThroughParam });
                            }
                            continue;
                        }
                    }
                    throw new OrgFormationError(`unable to find resource named ${ref}`);
                }
                results.push({ TemplateResource: foundElm });
            }
        }
        return results;
    }

    private throwForAccountIDs(resourceRefs: IResourceRef | IResourceRef[]): void {
        if (resourceRefs) {
            if (typeof resourceRefs === 'string') {
                if (resourceRefs.match(/\d{12}/)) {
                    throw new OrgFormationError(`error with account binding on ${resourceRefs}. Directly binding on accountid is not supported, use !Ref logicalId instead.`);
                }
                if (Array.isArray(resourceRefs)) {
                    for (const elm of resourceRefs) {
                        if (typeof elm === 'string') {
                            if (elm.match(/\d{12}/)) {
                                throw new OrgFormationError(`error with account binding on ${elm}. Directly binding on accountid is not supported, use !Ref logicalId instead.`);
                            }
                        }
                    }
                }
            }
        }
    }

    private collectAccountLogicalIdsFromOU(organizationalUnits: Reference<OrganizationalUnitResource>[]): Set<string> {
        const result = new Set<string>();
        const childOUs: Reference<OrganizationalUnitResource>[] = [];
        for (const unit of organizationalUnits) {
            const accountsForUnit = unit.TemplateResource!.accounts.map(x => x.TemplateResource!.logicalId);
            for (const logicalId of accountsForUnit) {
                result.add(logicalId);
            }
            childOUs.push(...unit.TemplateResource.organizationalUnits);
        }
        if (childOUs.length > 0) {
            for (const accountFromChildren of this.collectAccountLogicalIdsFromOU(childOUs)) {
                result.add(accountFromChildren);
            }
        }
        return result;
    }
}
