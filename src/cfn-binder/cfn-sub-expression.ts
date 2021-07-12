import { OrgFormationError } from '../org-formation-error';

export class SubExpression {
    public variables: ISubExpressionVariable[];
    public expression: string;
    public locals?: any;
    constructor(subValue: string | any[]) {
        if (!subValue) {
            throw new OrgFormationError('!Sub Value must not be undefined');
        }
        if (typeof subValue === 'string') {
            this.expression = subValue;
        } else if (Array.isArray(subValue)) {
            if (subValue.length === 0) {
                throw new OrgFormationError('!Sub Value must not be empty array');
            }
            if (typeof subValue[0] !== 'string') {
                throw new OrgFormationError('!Sub first element must be string');
            }
            this.expression = subValue[0];
            if (subValue.length > 1) {
                this.locals = subValue[1];
            }
        } else {
            throw new OrgFormationError('unable to parse !Sub expression');
        }
        const matches = this.expression.match(/\${([\w\:\.\-]*)}/g);
        if (!matches) {
            this.variables = [];
        } else {
            this.variables = matches.map(match => this.createSubExpressionVariable(match, this));
        }
    }
    public hasVariables(): boolean {
        return this.expression.indexOf('$') > -1;
    }
    public getSubValue(): string | any[] {
        if (!this.locals) {
            return this.expression;
        } else {
            return [
                this.expression,
                this.locals,
            ];
        }
    }
    private createSubExpressionVariable(match: string, that: SubExpression): ISubExpressionVariable {
        const expression = match.substr(2, match.length - 3);
        const parts = expression.split('.');
        const result: ISubExpressionVariable = {
            replace: (replacement: string) => {
                that.expression = that.expression.replace(match, replacement);
            },
            resource: parts[0],
        };
        if (parts.length > 1) {
            result.path = parts[1];
            if (parts.length > 2) {
                for (let i = 2; i < parts.length; i++) {
                    result.path += '.' + parts[i];
                }
            }
        }
        return result;
    }
}

export interface ISubExpressionVariable {
    resource: string;
    path?: string;
    replace(replacement: string): void;
}
