<!-- @import "[TOC]" {cmd="toc" depthFrom=2 depthTo=6 orderedList=false} -->

<!-- code_chunk_output -->

- [Parameters](#parameters)
- [Functions](#functions)
  - [!CopyValue](#copyvalue)
  - [!ReadFile](#readfile)
  - [!Cmd](#cmd)
  - [!MD5](#md5)
  - [!JsonString](#jsonstring)
  - [!Join](#join)
  - [!Sub](#sub)
  - [!Select](#select)
  - [!FindInMap](#findinmap)
  - [!Include](#include)
- [Task types](#task-types)
  - [update-organization](#update-organization)
  - [update-stacks](#update-stacks)
  - [update-serverless.com](#update-serverlesscom)
  - [copy-to-s3](#copy-to-s3)
  - [update-cdk](#update-cdk)
  - [register-type](#register-type)
  - [include](#include-1)
- [Templating](#templating)
  - [Example:](#example)

<!-- /code_chunk_output -->

# Automating deployments

You might well have multiple templates you would like to provision within your organization and manage centrally. Additionally might want to have a code repository set up with these templates and run them using a CI/CD solution.

A solution to update multiple Organization Formation templates at once is task files:

**example:**

```yaml
Parameters:
  resourcePrefix:
    Type: String
    Default: my

OrganizationUpdate:
  Type: update-organization
  Template: ./organization.yml

Roles:
  Type: update-stacks
  Template: ./roles.yml
  StackName: roles
  Parameters:
    ResourcePrefix: !Ref resourcePrefix

BudgetAlarms:
  Type: update-stacks
  Template: ./budget-alarms.yml
  StackName: budget-alarms
  Parameters:
    ResourcePrefix: !Ref resourcePrefix
```

The tasks listed in the file above can be executed using:

`> org-formation perform-tasks taskfile.yml [--profile my-aws-profile]`

For more info see the [cli reference](cli-reference.md)

## Parameters

Parameters can be declared in a top-level Parameters attribute and referred to throughout the taskfile using `!Ref` or from within a `!Sub` or `!Join` construct.

example:

```yaml
Parameters:
  stackPrefix:
    Description:
    Type: String

  includeMasterAccount:
    Description:
    Type: Boolean
    Default: true

BucketTemplate:
  Type: update-stacks
  Template: ./bucket.yml
  StackName: !Sub ${stackPrefix}-scenario-stack-parameters
  DefaultOrganizationBindingRegion: eu-west-1
  DefaultOrganizationBinding:
    IncludeMasterAccount: !Ref includeMasterAccount
```

Parameter values can be specified as default value or passed to th `perform-tasks` command over the command line using the following syntax:

```bash
\> org-formation perform-tasks taskfile.yml --parameters Param1=Val1 Param2=Val2
```

## Functions

The following functions can be used within a taskfile:

### !CopyValue

The `!CopyValue` will take up to 3 arguments _exportName_, _accountId_ and _region_ and it will return the value of the export (from the specified _accountId_ and _region_). Unlike `!ImportValue` it will continue to allow you to delete the stack that declares the export.

If _accountId_ and/or _region_) are not specified the account and region of the target are used. If you have an Organization Binding with 6 targets and do not specify _accountId_ or _region_ the export is expected to be found in all 6 targets (Account/Region combinations).

The following example shows various ways to use the !CopyValue function:

```yaml
PolicyTemplate:
  DependsOn: BucketTemplate
  Type: update-stacks
  Template: ./bucket-policy.yml
  StackName: scenario-export-bucket-role
  DefaultOrganizationBindingRegion: eu-west-1
  DefaultOrganizationBinding:
    IncludeMasterAccount: true
  Parameters:
    bucketArn: !CopyValue BucketArn
    bucketArn2: !CopyValue [BucketArn, !Ref MasterAccount]
    bucketArn4: !CopyValue [BucketArn, !Ref MasterAccount, "eu-west-1"]
    bucketArn3: !CopyValue [BucketArn, 123123123123, "eu-west-1"]
```

### !ReadFile

The `!ReadFile` function will take 1 string argument, a file path, and return the contents of the file as a string.

### !Cmd

The `!Cmd` function will take 1 string argument, a shell command, and return the output from the
shell command as a string.

Example:

```yaml
Parameters:
  Note: !Cmd 'echo "Deployed by `whoami`"'
  License: !Cmd "wget -qO-  https://raw.githubusercontent.com/org-formation/org-formation-cli/master/LICENSE"
  EC2ImageIdUbuntu: !Cmd >-
    aws ssm get-parameters
    --profile dev
    --region us-east-1
    --names /aws/service/canonical/ubuntu/server/20.04/stable/current/amd64/hvm/ebs-gp2/ami-id
    --query 'Parameters[0].[Value]'
    --output text
```

### !MD5

The `!MD5` function will take 1 argument and return a message digest over its value. If the argument is a string, the function will calculate a message digest over the string. If the value is an object the `!MD5` function will create a message digest over the JSON string representation of the contents.

See the following examples:

```yaml
CopyFileWithHashInKey:
  Type: copy-to-s3
  LocalPath: ./source-file.yml
  RemotePath: !Sub
    - "s3://organization-formation-${AWS::AccountId}/remote-path-${hashOfFile}.yml"
    - { hashOfFile: !MD5 { file: !ReadFile "./source-file.yml" } }
  OrganizationBinding:
    IncludeMasterAccount: true
    Region: us-east-1
```

### !JsonString

The `!JsonString` function will take 1 or 2 arguments. The first argument will be converted to a JSON string representation. If the second argument is the literal 'pretty-print', the result will contain whitespace, otherwise the result will not contain whitespace. If the first argument is a string, the string will be first converted to an object (assuming the string as json) prior to returning the string representation (therefore minifying the input string).

### !Join

The function `!Join` appends a set of values into a single value, separated by the specified delimiter.
If a delimiter is the empty string, the set of values are concatenated with no delimiter.

The following example returns: "a:b:c"

```yaml
!Join [":", [a, b, c]]
```

### !Sub

The function `!Sub` substitutes variables in an input string with values that you specify.
In your templates, you can use this function to construct commands or outputs that include
values that aren't available until you create or update a stack.

The following example uses `!Sub` to create a string containing values from resourcePrefix
and AWSAccount alias parameters.

```yaml
!Sub "${resourcePrefix}-budget-${AWSAccount.Alias}"
```

### !Select

The function `!Select` returns a single object from a list of objects by index.

The following example returns: "grapes"

```yaml
{ "Fn::Select": ["1", ["apples", "grapes", "oranges", "mangoes"]] }
```

### !FindInMap

The function `!FindInMap` returns the value corresponding to keys in a two-level map that is
declared in a map.

Example:

```yaml
Mappings:
  MyMap:
    IpAddresses:
      112233112233: 10.201.30
      112233112234: 10.201.31

MyStack:
  Type: update-stacks
  Template: ./template.yml
  StackName: just-an-example
  Parameters:
    ip: !FindInMap [MyMap, IpAddresses, !Ref CurrentAccount]
```

### !Include

The function `!Include` can be be used in a task or an organization file to include part of the model
(it includes before parsing). This can be useful when storing parameters in a central location and
reference them from multiple files.

Example:

in default_tags.yml

```yaml
Department: Engineering
Project: Infrastructure
CloudwatchRetentionPeriod: 90
```

in organization.yml

```yaml
Organization:
  MasterAccount:
    Type: OC::ORG::MasterAccount
    Properties:
      AccountName: organizations
      RootEmail: organizations@acme.org
      Alias: org-acme-organizations
      Tags:
        <<: !Include ./default_tags.yml
        CloudwatchRetentionPeriod: 365 # override a default tag
  SandboxAccount:
    Type: OC::ORG::Account
    Properties:
      AccountName: sandbox
      RootEmail: sandbox@acme.org
      Alias: org-acme-sandbox
      Tags:
        <<: !Include ./default_tags.yml
        Team: developers # add an additional tag
```

## Task types

### update-organization

The `update-organization` task will update all the organization resources based on the template specified as `Template`.

| Attribute         | Value             | Remarks                                                      |
| :---------------- | :---------------- | :----------------------------------------------------------- |
| Template          | relative path     | This property is required.                                   |
| Skip              | `true` or `false` | When `true` task (and dependent tasks) will not be executed. |
| TemplatingContext | Dictionary        | Specifies the data for [templating](#templating).            |

### update-stacks

The `update-stacks` task will provision all resources in all accounts specified in `Template`.

| Attribute                        | Value                                                                                                                                                                                           | Remarks                                                                                                                                                                                                                                                                             |
| :------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Template                         | relative path, absolute path, s3:// or https://                                                                                                                                                 | This property is required. <br/><br/>Specifies the Organization Formation/ CloudFormation template of which the resources must be updated.<br/><br/> Template can be either a relative or absolute file path, url or s3 file (s3://{bucketName}/path/to/object.yml)                 |
| DependsOn                        | Name of task or list of names                                                                                                                                                                   | The tasks listed in this attribute will be executed before this task.                                                                                                                                                                                                               |
| Skip                             | `true` or `false`                                                                                                                                                                               | When `true` task (and dependent tasks) will not be executed.                                                                                                                                                                                                                        |
| StackName                        | string                                                                                                                                                                                          | This property is required.<br/><br/>Specifies the name of the stack that will be created in all accounts/regions.                                                                                                                                                                   |
| StackDescription                 | string                                                                                                                                                                                          | If specified, value will be set as the description of the created stacks<br/><br/> **note**: This value overrides values within the template or resources (value in taskfile is leading).                                                                                           |
| Parameters                       | Dictionary                                                                                                                                                                                      | Specifies parameters that must be used when executing the template.                                                                                                                                                                                                                 |
| TemplatingContext                | Dictionary                                                                                                                                                                                      | Specifies the data for [templating](#templating).                                                                                                                                                                                                                                   |
| OrganizationFile                 | relative path                                                                                                                                                                                   | Organization file used when executing templates.<br/><br/>**note**: This value overrides values within the template or resources (value in taskfile is leading).<br/><br/> **note**: This value can also be used if template is plain CloudFormation.                               |
| TerminationProtection            | true or false                                                                                                                                                                                   | When set to `true` termination protection will be enabled on all stacks created for this template.                                                                                                                                                                                  |
| UpdateProtection                 | true or false                                                                                                                                                                                   | When set to `true` will create a StackPolicy for the stacks that prevents any resource from being modified through CloudFormation.                                                                                                                                                  |
| StackPolicy                      | stack policy                                                                                                                                                                                    | When specified will apply stack policy to all stacks created.                                                                                                                                                                                                                       |
| Tags                             | Dictionary (attribute names are keys, attribute values are values)                                                                                                                              | When specified stack tags are created and propagated to resources being managed by stack. created.                                                                                                                                                                                  |
| DefaultOrganizationBindingRegion | String or list of String                                                                                                                                                                        | Region or regions that will be used for any binding without Region specified.<br/><br/> **note**: This value overrides values within the template or resources (value in taskfile is leading).<br/><br/> **note**: This value can also be used if template is plain CloudFormation. |
| DefaultOrganizationBinding       | [OrganizationBinding](https://github.com/org-formation/org-formation-cli/blob/master/docs/cloudformation-resources.md#organizationbinding-where-to-create-which-resource)                       | Organization binding used for any resource that has no binding specified.<br/><br/> **note**: This value overrides values within the template or resources (value in taskfile is leading). <br/><br/> **note**: This value can also be used if template is plain CloudFormation.    |
| OrganizationBindings             | Dictionary of String, [OrganizationBinding](https://github.com/org-formation/org-formation-cli/blob/master/docs/cloudformation-resources.md#organizationbinding-where-to-create-which-resource) | Set of named OrganizationBindings that can be `!Ref`'d by Resources.<br/><br/> **note**: This value overrides values within the template or resources (value in taskfile is leading).                                                                                               |
| CloudFormationRoleName           | string                                                                                                                                                                                          | Specifies the name of the IAM Role that must be used to pass to the CloudFormation service. A role with this is expected to exist in the target account (and have the right AssumeRole permissions).                                                                                |
| TaskRoleName                     | string                                                                                                                                                                                          | Specifies the name of the IAM Role that must be used for cross account access. A role with this is expected to exist in the target account (and have the right AssumeRole permissions).                                                                                             |
| MaxConcurrentStacks              | number                                                                                                                                                                                          | The number of stacks that should be executed concurrently.<br/><br/> Default = 1                                                                                                                                                                                                    |

**example**

```yaml
BudgetAlarms:
  Type: update-stacks
  Template: ./budget-alarms.yml
  StackName: budget-alarms
  TerminationProtection: true
  UpdateProtection: false
  DefaultOrganizationBindingRegion: eu-central-1
  OrganizationBindings:
    BudgetAlarmBinding:
      AccountsWithTag: budget-alarm-threshold
  Parameters:
    resourcePrefix: my
```

```yaml
Roles:
  Type: update-stacks
  Template: ./cross-account-role.yml
  StackName: developer-role
  StackDescription: "Developer Role"
  TerminationProtection: false
  UpdateProtection: true
  Tags:
    tag: tag-value
    anotherTag: another-val
  Parameters:
    roleName: DeveloperRole
    rolePolicyArns:
      - arn:aws:iam::aws:policy/PowerUserAccess
  OrganizationBindings:
    RoleAccountBinding:
      OrganizationalUnit: !Ref DevelopmentOU
    AssumeRoleBinding:
      Account: !Ref SharedUsersAccount
```

### update-serverless.com

The `update-serverless.com` task will deploy the [serverless.com](https://serverless.com) workload defined in the directory specified by `Path`.

| Attribute           | Value                                                                                                                                                                     | Remarks                                                                                                                                                                                                                                              |
| :------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Path                | relative path                                                                                                                                                             | This property is required. <br/><br/>Specifies which directory contains the serverless.com workload                                                                                                                                                  |
| OrganizationBinding | [OrganizationBinding](https://github.com/org-formation/org-formation-cli/blob/master/docs/cloudformation-resources.md#organizationbinding-where-to-create-which-resource) | This property is required. <br/><br/>Organization binding used to specify which accounts the serverless.com workload needs to be deployed to.                                                                                                        |
| Config              | relative path                                                                                                                                                             | Name of the Serverless.com configuration file that contains information about the payload.<br/><br/>default is **./serverless.yml**                                                                                                                  |
| Stage               | string                                                                                                                                                                    | Value used as stage when deploying the serverless.com workload                                                                                                                                                                                       |
| RunNpmInstall       | boolean                                                                                                                                                                   | When true, `npm ci` will be ran before serverless deployment and removal                                                                                                                                                                             |
| CustomDeployCommand | string                                                                                                                                                                    | When specified will override the default command used when deploying a serverless.com workload. <br/><br/>default command is: `npm ci && npx sls deploy ${CurrentTask.Parameters} --region ${region} --stage ${stage} --config ${config} --conceal`. |
| CustomRemoveCommand | string                                                                                                                                                                    | When specified will override the default command used when removing a serverless.com workload. <br/><br/>default command is: `npm ci && npx sls remove ${CurrentTask.Parameters} --region ${region} --stage ${stage} --config ${config} --conceal`.  |
| DependsOn           | Name of task or list of names                                                                                                                                             | The tasks listed in this attribute will be executed before this task.                                                                                                                                                                                |
| Skip                | `true` or `false`                                                                                                                                                         | When `true` task (and dependent tasks) will not be executed.                                                                                                                                                                                         |
| TaskRoleName        | string                                                                                                                                                                    | Specifies the name of the IAM Role that must be used for cross account access. A role with this is expected to exist in the target account (and have the right AssumeRole permissions).                                                              |
| Parameters          | any                                                                                                                                                                       | Specifies parameters that must be passed to the serverless deployment using command arguments.                                                                                                                                                       |

**example**

```yaml
ServerlessWorkload:
  Type: update-serverless.com
  Config: serverless.yml
  Path: ./workload/
  Stage: dev
  Parameters:
    resourcePrefix: my
  OrganizationBinding:
    Account: !Ref AccountA
```

### copy-to-s3

The `copy-to-s3` task will upload a file from `LocalPath` to an S3 `RemotePath`.

| Attribute           | Value                                                                                                                                                                     | Remarks                                                                                                                                                                                 |
| :------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LocalPath           | relative path                                                                                                                                                             | This property is required. <br/><br/>Specifies the file that needs to be uploaded.                                                                                                      |
| RemotePath          | S3 moniker                                                                                                                                                                | This property is required. <br/><br/>Specifies the location in S3 that the file should be uploaded to.                                                                                  |
| OrganizationBinding | [OrganizationBinding](https://github.com/org-formation/org-formation-cli/blob/master/docs/cloudformation-resources.md#organizationbinding-where-to-create-which-resource) | This property is required. <br/><br/>Organization binding used to specify which accounts the s3 file needs to be copied to.                                                             |
| DependsOn           | Name of task or list of names                                                                                                                                             | The tasks listed in this attribute will be executed before this task.                                                                                                                   |
| Skip                | `true` or `false`                                                                                                                                                         | When `true` task (and dependent tasks) will not be executed.                                                                                                                            |
| TaskRoleName        | string                                                                                                                                                                    | Specifies the name of the IAM Role that must be used for cross account access. A role with this is expected to exist in the target account (and have the right AssumeRole permissions). |

**example**

```yaml
CopyToS3:
  Type: copy-to-s3
  LocalPath: ./files/file.txt
  RemotePath: s3://my-bucket/files/file.txt
  OrganizationBinding:
    Account: !Ref AccountA
    Region: eu-central-1
```

### update-cdk

The `update-cdk` task will deploy the a CDK workload defined in the directory specified by `Path`.

| Attribute           | Value                                                                                                                                                                     | Remarks                                                                                                                                                                                               |
| :------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Path                | relative path                                                                                                                                                             | This property is required. <br/><br/>Specifies which directory contains the serverless.com workload                                                                                                   |
| OrganizationBinding | [OrganizationBinding](https://github.com/org-formation/org-formation-cli/blob/master/docs/cloudformation-resources.md#organizationbinding-where-to-create-which-resource) | This property is required. <br/><br/>Organization binding used to specify which accounts the CDK workload needs to be deployed to.                                                                    |
| RunNpmInstall       | boolean                                                                                                                                                                   | When true, `npm ci` will be ran before CDK and removal                                                                                                                                                |
| RunNpmBuild         | boolean                                                                                                                                                                   | When true, `npm run build` will be ran before CDK and removal                                                                                                                                         |
| CustomDeployCommand | string                                                                                                                                                                    | When specified will override the default command used when deploying a serverless.com workload. <br/><br/>default command is: `npm ci && npm run build && npx cdk deploy ${CurrentTask.Parameters} `. |
| CustomRemoveCommand | string                                                                                                                                                                    | When specified will override the default command used when removing a CDK workload. <br/><br/>default command is: `npm ci && npm run build && npx cdk destroy ${CurrentTask.Parameters} `.            |
| DependsOn           | Name of task or list of names                                                                                                                                             | The tasks listed in this attribute will be executed before this task.                                                                                                                                 |
| Skip                | `true` or `false`                                                                                                                                                         | When `true` task (and dependent tasks) will not be executed.                                                                                                                                          |
| TaskRoleName        | string                                                                                                                                                                    | Specifies the name of the IAM Role that must be used for cross account access. A role with this is expected to exist in the target account (and have the right AssumeRole permissions).               |
| Parameters          | any                                                                                                                                                                       | Specifies parameters that must be passed to the cdk deployment using `-c` arguments.                                                                                                                  |

**example**

```yaml
CdkWorkload:
  Type: update-cdk
  Path: ./workload/
  RunNpmInstall: true
  RunNpmBuild: true
  Parameters:
    resourcePrefix: my
  OrganizationBinding:
    Account: !Ref AccountA
```

### register-type

The `register-type` task will deploy a CloudFormation Resource Provider and register a CloudFormation type.

For more information see: https://docs.aws.amazon.com/cloudformation-cli/latest/userguide/resource-types.html

| Attribute            | Value                                                                                                                                                                     | Remarks                                                                                                                                                                                 |
| :------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ResourceType         | Name of type                                                                                                                                                              | The typename that can be used in CloudFormation (e.g. Community::MyService::MyResource).                                                                                                |
| SchemaHandlerPackage | S3 path to implementation                                                                                                                                                 | The S3 Path to the implementation (e.g. s3://my-bucket/type-1.0.0.zip).                                                                                                                 |
| OrganizationBinding  | [OrganizationBinding](https://github.com/org-formation/org-formation-cli/blob/master/docs/cloudformation-resources.md#organizationbinding-where-to-create-which-resource) | This property is required. <br/><br/>Organization binding used to specify which accounts/regions the Resource Provider needs to be registered.                                          |
| DependsOn            | Name of task or list of names                                                                                                                                             | The tasks listed in this attribute will be executed before this task.                                                                                                                   |
| Skip                 | `true` or `false`                                                                                                                                                         | When `true` task (and dependent tasks) will not be executed.                                                                                                                            |
| TaskRoleName         | string                                                                                                                                                                    | Specifies the name of the IAM Role that must be used for cross account access. A role with this is expected to exist in the target account (and have the right AssumeRole permissions). |

**example**

```yaml
DelayRP:
  Type: register-type
  SchemaHandlerPackage: s3://community-resource-provider-catalog/community-cloudformation-delay-0.1.0.zip
  ResourceType: "Community::CloudFormation::Delay"
  MaxConcurrentTasks: 10
  OrganizationBinding:
    Region: us-east-1
    Account: "*"
```

Looking for community resource providers? check out the [org-formation/aws-resource-providers](https://github.com/org-formation/aws-resource-providers) repository!

### include

The `include` include another taskfile with tasks to be executed.

| Attribute           | Value                         | Remarks                                                                                                                                             |
| :------------------ | :---------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------- |
| DependsOn           | Name of task or list of names | The tasks listed in this attribute will be executed before this task.                                                                               |
| Skip                | `true` or `false`             | When `true` task (and dependent tasks) will not be executed.                                                                                        |
| Path                | relative path                 | This property is required.<br/><br/> Specifies the Path of the taskfile that should be included.                                                    |
| MaxConcurrentTasks  | number                        | The number of tasks within the imported file that should be executed concurrently.<br/><br/> Default = 1                                            |
| FailedTaskTolerance | number                        | The number of failed tasks within the imported file that will cause the tasks to fail.<br/><br/> Default = 0                                        |
| Parameters          | any                           | Specifies values to parameters declared in the included taskfile. If not specified values passed to the current are passed to the included taskfile |
| TemplatingContext   | Dictionary                    | Specifies the data for [templating](#templating).                                                                                                   |

**example**

```yaml
Include:
  Type: include
  DependsOn: otherTask
  Path: ./build-tasks-include.yml
  MaxConcurrentTasks: 10
  FailedTaskTolerance: 10
  Parameters:
    resourcePrefix: my
```

## Templating

Org-formation supports the [nunjucks](https://mozilla.github.io/nunjucks/) template engine to generate cloudformation
templates from nunjucks based templates.

### Example:

Assume we want to create one security group that allows access from multiple ingress ports.

security-group.njk:

```yaml
Description: Nunjucks Security group template
AWSTemplateFormatVersion: 2010-09-09
Resources:
  SecurityGroup:
    Type: 'AWS::EC2::SecurityGroup'
    Properties:
      GroupDescription: "Open ports for incoming traffic"
      VpcId: "vpc-1234ABC"
      SecurityGroupIngress:
{% for port in ports %}
        - CidrIp: "0.0.0.0/0"
          FromPort: {{ port }}
          ToPort: {{ port }}
          IpProtocol: tcp
{% endfor %}
```

Deploy with [update-stacks](#update-stacks) and pass in port values with `TemplatingContext`:

```yaml
SecurityGroupExample:
  Type: update-stacks
  Template: ./security-group.njk
  StackName: SecurityGroupExample
  TemplatingContext:
    ports:
      - 22
      - 80
  DefaultOrganizationBinding:
    Account: "*"
    Region: us-east-1
```

**Note**: If you want templating without passing in any data you must set `TempatingContext: {}` to trigger templating.

The generated cloudformation template:

```yaml
AWSTemplateFormatVersion: "2010-09-09"
Description: Security group using nunjucks
Parameters: {}
Resources:
  SecurityGroup:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupDescription: Open ports for incoming traffic
      VpcId: vpc-1234ABC
      SecurityGroupIngress:
        - CidrIp: 0.0.0.0/0
          FromPort: 22
          ToPort: 22
          IpProtocol: tcp
        - CidrIp: 0.0.0.0/0
          FromPort: 80
          ToPort: 80
          IpProtocol: tcp
Outputs: {}
```

it is possible to mix text templating with other functions, e.g.:

```yaml
Include:
  Type: include
  Path: ./included-task.njk
  TemplatingContext:
    Teams: !Include ./teams.json
    Parameters:
      Switch: !Ref switch
      Partition: !Ref AWS::Partition
      Substitute: !Sub "Current Account: ${CurrentAccount}"
    Accounts: Fn::EnumTargetAccounts MasterAccount
    Regions: Fn::EnumTargetRegions MasterAccount
```

if you want to apply text templating to the organization.yml file you can add it to the update-organization

```yaml
OrganizationUpdate:
  Type: update-organization
  Template: ./organization.njk
  TemplatingContext: !Include ./templating-context.json
```

note that if you use an .org-formationrc file to specify you organization.yml file, you must also specify the templating context in the .org-formationrc file:

```ini
organizationFile = ./organization.njk
templatingContext = ./templating-context.json
```
