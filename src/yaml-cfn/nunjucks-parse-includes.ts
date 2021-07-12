import { readFileSync } from 'fs';
import path from 'path';
import { nunjucksParse } from '.';

const include = /!Include\s+('|")?([^'"\s]*)('|")?/g;
export const nunjucksParseContentWithIncludes = (contents: string, directory: string, filename: string, templatingContext: any): any => {
    const replacedContents = contents.replace(include, (_, __, includedRelativeFilePath) => {

        const resolvedFilePath = path.resolve(directory, includedRelativeFilePath);
        const included = nunjucksParseWithIncludes(resolvedFilePath, templatingContext);
        return JSON.stringify(included);
    });

    const parsed = nunjucksParse(replacedContents, filename, templatingContext);
    return parsed;
};

export const nunjucksParseWithIncludes = (filePath: string, templatingContext: any): any => {
    const buffer = readFileSync(filePath);
    const contents = buffer.toString('utf-8');
    const dir = path.dirname(filePath);
    const filename = path.basename(filePath);
    return nunjucksParseContentWithIncludes(contents, dir, filename, templatingContext);
};
