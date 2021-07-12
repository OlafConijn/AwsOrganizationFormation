import { IResource, IResourceRef, TemplateRoot } from '../parser';
import { Reference, Resource } from './resource';
import { ServiceControlPolicyResource } from './service-control-policy-resource';

export interface IOrganizationRootProperties {
    ServiceControlPolicies: IResourceRef | IResourceRef[];
    DefaultOrganizationAccessRoleName?: string;
    DefaultBuildAccessRoleName?: string;
    MirrorInGovCloud?: boolean;
}

/**
 * Added a mirrorInGovCloud field. This is essential for creating the accounts in govcloud.
 */

export class OrganizationRootResource extends Resource {
    public serviceControlPolicies: Reference<ServiceControlPolicyResource>[] = [];
    private props: IOrganizationRootProperties;
    public defaultOrganizationAccessRoleName?: string;
    public defaultBuildAccessRoleName?: string;
    public mirrorInGovCloud?: boolean;

    constructor(root: TemplateRoot, id: string, resource: IResource) {
        super(root, id, resource);

        this.props = this.resource.Properties as IOrganizationRootProperties;

        super.throwForUnknownAttributes(resource, id, 'Type', 'Properties');
        super.throwForUnknownAttributes(this.props, id, 'ServiceControlPolicies', 'DefaultOrganizationAccessRoleName', 'DefaultBuildAccessRoleName', 'MirrorInGovCloud');

        if (this.props) {
            this.defaultOrganizationAccessRoleName = this.props.DefaultOrganizationAccessRoleName;
            this.defaultBuildAccessRoleName = this.props.DefaultBuildAccessRoleName;
            this.mirrorInGovCloud = this.props.MirrorInGovCloud;
        }
    }

    public resolveRefs(): void {
        if (this.props) {
            this.serviceControlPolicies = super.resolve(this.props.ServiceControlPolicies, this.root.organizationSection.serviceControlPolicies);
        } else  {
            this.serviceControlPolicies = [];
        }
    }
}
