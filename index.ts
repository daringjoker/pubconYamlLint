import {z} from 'zod';
import * as _ from "lodash";
import * as YAML from 'yaml';
import {readFileSync} from 'fs';
import * as xsd from 'libxmljs2-xsd';
import {XMLParser} from 'fast-xml-parser';

const pubconYamlSchema = z.object({
    scope: z.literal('BILLING'), type: z.string(), batch: z.object({
        enabled: z.boolean(), conditions: z.object({
            triggerCount: z.number().min(0), ttlSeconds: z.number().min(0),
        }), bulkSubmit: z.boolean(), batchSize: z.number().min(1).optional(),
    }), watching: z.object({
        entity: z.record(z.string(), z.array(z.enum(['Update', 'Create', 'Delete'])).nonempty()),
        columns: z.array(z.string().nonempty()).nonempty()
    }), query: z.array(z.object({
        label: z.string().min(1),
        type: z.enum(["main", "lookup"]),
        language: z.enum(['fetchxml']),
        param: z.array(z.string().nonempty()).nonempty().optional(),
        headers: z.array(z.string().nonempty()).nonempty(),
        queryText: z.string().nonempty()
    })).nonempty().refine(queries => {
        const mainQueries = queries.filter(query => query.type === 'main')
        return mainQueries.length === 1
    }, "One of the queries must have type 'main'").superRefine((queries, ctx) => {
        const labelCount: Record<string, number> = queries.reduce((obj, x) => {
            obj[x.label] = (obj[x.label] || 0) + 1;
            return obj
        }, {}) as unknown as Record<string, number>;

        const multipleLabels = Object.entries(labelCount).filter(([label, count]) => count !== 1).map(([label, count]) => `'${label}'`);

        if (multipleLabels.length) {
            ctx.addIssue({
                code: z.ZodIssueCode.too_big,
                maximum: 1,
                type: "array",
                inclusive: true,
                message: `the query labels ${multipleLabels} appear more than once`
            });
        }
    })
})

function ValidateYaml(content: Buffer, fileName: string) {
    try {
        const parsedContent = YAML.parse(content.toString('utf8'));
        return parsedContent;
    } catch (exception) {
        const ex = exception as YAML.YAMLParseError;
        console.log(`ERROR: in ${fileName}:${ex?.linePos?.[0].line || ''}\n\t${ex.message}`)
        process.exit(-1)
    }
}

function validatePubconSchema(YamlContent: Record<string, any>) {
    try {
        const valid = pubconYamlSchema.parse(YamlContent);
        return valid
    } catch (exception) {
        const errors = exception as z.ZodError;
        console.log(errors.issues.map(err => `ERROR: on path pubconYaml['${err.path.join("']['")}'] : ${err.message}`).join("\n"), "\n")
    }
}

function validateFetchXml(fetchXml: z.infer<typeof pubconYamlSchema>['query']) {
    const fetchXmlSchema = xsd.parseFile("./fetchXml.xsd");
    const fetchXmlErrors = fetchXml.map(query => {
        try {
            const validationErrors = _.uniq(fetchXmlSchema.validate(query.queryText));
            if (validationErrors.length) {
                return validationErrors.map(err => `ERROR: in the fetchXml for : '${query.label}' \n\t ${err.message}`)
            }
        } catch (exception) {
            const err = exception as Error;
            return `ERROR: in the fetchXML for : '${query.label}' \n\t ${err.message}`
        }

    }).filter(error => !!error);

    if (fetchXmlErrors.length) {
        _.flatten(fetchXmlErrors).forEach(err => console.log(err));
        process.exit(-1);
    }

    const parser = new XMLParser({ignoreAttributes: false, ignoreDeclaration: false, alwaysCreateTextNode: true});
    fetchXml.map(query => ({...query, parsedQuery: parser.parse(query.queryText)})).forEach(q => {
        const countObj: Record<string, number> = {};
        const qHeaders = generateValidHeaders(q.parsedQuery['fetch']['entity']);
        _.uniq(qHeaders).forEach(x => {
            countObj[x] = (countObj[x] || 0) + 1
        })
        _.uniq(q.headers).forEach(x => {
            countObj[x] = (countObj[x] || 0) - 1
        })
        const onlyInQuery = Object.entries(countObj).filter(([header, count]) => count > 0).map(([header, count]) => header);
        const onlyInHeader = Object.entries(countObj).filter(([header, count]) => count < 0).map(([header, count]) => header);
        if (onlyInHeader.length || onlyInHeader.length) {
            console.log(`ERROR: in query of label '${q.label}'`)
        }
        if (onlyInQuery.length) {
            console.log(`\tThe following attributes are present in the Query but not in the headers\n\t\t${onlyInQuery.join("\n\t\t")}\n`)
        }
        if (onlyInHeader.length) {
            console.log(`\tThe following attributes are present in the Header but not in the query\n\t\t${onlyInHeader.join("\n\t\t")}`)
        }
    });

    return fetchXml;
}

function ensureArray(obj: any) {
    if (!obj) return [];
    return Array.isArray(obj) ? obj : [obj];
}

function generateValidHeaders(parsedQueries: any, parentName = '') {
    if (!parsedQueries) return [];

    const myHeaders = ensureArray(parsedQueries.attribute)?.map(q => {
        return q['@_alias'] ?? `${parentName.length ? parentName + "." : ""}${q['@_name']}`
    }) || []
    const childHeaders = ensureArray(parsedQueries['link-entity'])?.map(q => generateValidHeaders(q, q['@_alias'] ?? q['@_name'])) || []
    return [...myHeaders, ..._.flatten(childHeaders)]
}

function main() {
    const fileName = process.argv[2];
    const fileContent = readFileSync(fileName)
    const yamlData = ValidateYaml(fileContent, fileName);
    const valid = validatePubconSchema(yamlData);
    const parsedQueries = validateFetchXml(yamlData.query);
}

main()




