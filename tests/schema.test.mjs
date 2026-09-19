import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { inspectHar, shareReport, compareReports } from '../dist/index.js';
import { RULE_IDS } from '../dist/rules.js';
import { contract, har } from './helpers.mjs';
const ajv = new Ajv2020({ strict: true });
ajv.addFormat('date-time', (v) => /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v)));
const schemas = Object.fromEntries(
  await Promise.all(
    ['contract', 'report', 'comparison'].map(async (name) => [
      name,
      JSON.parse(await readFile(`schemas/${name}.schema.json`, 'utf8')),
    ]),
  ),
);
test('published schemas validate actual private/shared reports and comparison output', () => {
  const report = inspectHar(har(), { contract });
  for (const [name, values] of Object.entries({
    contract: [contract, { ...contract, pathStyle: true }],
    report: [report, shareReport(report)],
    comparison: [compareReports(report, report)],
  })) {
    const validate = ajv.compile(schemas[name]);
    for (const value of values) assert.ok(validate(value), JSON.stringify(validate.errors));
  }
});
test('published rule catalog agrees with schema and prohibits unexpected fields', () => {
  assert.deepEqual(
    [...schemas.report.properties.findings.items.properties.ruleId.enum].sort(),
    [...RULE_IDS].sort(),
  );
  const validate = ajv.compile(schemas.report);
  const report = inspectHar(har());
  report.rawSignedUrl = 'secret';
  assert.equal(validate(report), false);
});
