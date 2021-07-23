import fs from 'fs';
import { promisify } from 'util';
import path from 'path';
import { getDMMF, getConfig } from '@prisma/sdk';
import {
  deserializeEnums,
  deserializeDatasources,
  deserializeModels,
  deserializeGenerators,
  Model
} from './deserializer';
import { DataSource, DMMF, GeneratorConfig } from '@prisma/generator-helper/dist';

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);

export interface MixerOptions {
  input: string[];
  output: string;
}

export interface PrismixOptions {
  mixers: MixerOptions[];
}

type UnPromisify<T> = T extends Promise<infer U> ? U : T;

type Schema = UnPromisify<ReturnType<typeof getSchema>>;

async function getSchema(schemaPath: string) {
  const schema = await readFile(path.join(process.cwd(), schemaPath), {
    encoding: 'utf-8'
  });

  const dmmf = await getDMMF({ datamodel: schema });
  const config = await getConfig({ datamodel: schema });

  return {
    models: dmmf.datamodel.models as Model[],
    enums: dmmf.datamodel.enums,
    datasources: config.datasources,
    generators: config.generators
  };
}

function mixModels(inputModels: Model[]) {
  const models: Record<string, Model> = {};
  for (const newModel of inputModels) {
    const existingModel: Model | null = models[newModel.name];

    // if the model already exists in our found models, merge the fields
    if (existingModel) {
      const existingFieldNames = existingModel.fields.map((f) => f.name);
      for (const newField of newModel.fields) {
        // if this field exists in the existing model
        if (existingFieldNames.includes(newField.name)) {
          const existingFieldIndex: number = existingFieldNames.indexOf(newField.name);
          // replace the field at this index with the new one
          existingModel.fields[existingFieldIndex] = newField;
        } else {
          // if it doesn't already exist, append to field list
          existingModel.fields.push(newField);
        }
      }
    } else {
      models[newModel.name] = newModel;
    }
  }
  return Object.values(models);
}

export async function prismix(options: PrismixOptions) {
  for (const mixer of options.mixers) {
    const schemasToMix: Schema[] = [];

    // load the schema data for all inputs
    for (const input of mixer.input) schemasToMix.push(await getSchema(input));

    // extract all models and mix
    let models: Model[] = [];
    for (const schema of schemasToMix) models = [...models, ...schema.models];
    models = mixModels(models);

    let enums: DMMF.DatamodelEnum[] = [];
    schemasToMix.forEach((schema) => !!schema.enums && (enums = [...enums, ...schema.enums]));

    // use the last found datasources
    let datasources: DataSource[] = [];
    schemasToMix.forEach(
      (schema) => schema.datasources.length > 0 && (datasources = schema.datasources)
    );
    // use the last found generators
    let generators: GeneratorConfig[] = [];
    schemasToMix.forEach(
      (schema) => schema.generators.length > 0 && (generators = schema.generators)
    );

    let outputSchema = [
      await deserializeDatasources(datasources),
      await deserializeGenerators(generators),
      await deserializeModels(models),
      await deserializeEnums(enums)
    ]
      .filter((e) => e)
      .join('\n\n\n');

    await writeFile(path.join(process.cwd(), mixer.output), outputSchema);
  }
}
