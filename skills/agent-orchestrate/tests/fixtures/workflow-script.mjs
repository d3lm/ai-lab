#!/usr/bin/env node

import fs from 'node:fs';
import { openWorkflow } from '../../scripts/lib/index.mjs';

const [runDir, specFile] = process.argv.slice(2);
const turn = JSON.parse(fs.readFileSync(specFile, 'utf8'));
const workflow = await openWorkflow({ runDir, kind: 'test', label: 'workflow script' });

try {
  console.log(JSON.stringify(await workflow.runTurn(turn)));
} finally {
  workflow.close();
}
