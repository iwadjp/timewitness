'use strict';
const fs = require('node:fs');
const path = require('node:path');
// Keep assertion failures separate from a broken test environment.
module.exports = async function* (events) {
  for await (const { type, data } of events) {
    if (!['test:pass', 'test:fail', 'test:summary'].includes(type)) continue;
    const error = data.details?.error;
    fs.writeSync(3, JSON.stringify({
      type, name: data.name, file: data.file, nesting: data.nesting, testType: data.details?.type,
      fileWrapper: data.line === 1 && data.column === 1 && !!data.file
        && [data.file, path.relative(process.cwd(), data.file), path.basename(data.file)]
          .some(name => name.replaceAll('\\', '/') === String(data.name).replaceAll('\\', '/')),
      skip: !!data.skip, todo: !!data.todo,
      failureType: error?.failureType,
      code: error?.cause?.code || error?.code,
      success: data.success,
    }) + '\n');
  }
};
