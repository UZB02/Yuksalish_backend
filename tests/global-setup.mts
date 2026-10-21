import { MongoMemoryServer } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

// Barcha test fayllari uchun bitta xotiradagi MongoDB
export default async function setup(project: TestProject) {
  const mongod = await MongoMemoryServer.create();
  project.provide('mongoUri', mongod.getUri());
  return async () => {
    await mongod.stop();
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}
