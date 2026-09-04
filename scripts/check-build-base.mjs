// Fails the build if the emitted HTML references assets outside the base path
// of the deployment target it was built for.
//
// This is the guard against the white screen: an official build whose HTML
// still points at `/nostr-farm/assets/...` loads on https://farm.blobbi.pet
// but cannot fetch its own bundle. Hashed file names are not inspected, only
// the path each reference starts with.
import { existsSync, readFileSync } from 'node:fs';

import { findAssetRefsOutsideBase, resolveDeployTarget } from './deploy-target.mjs';

const { name, base } = resolveDeployTarget(process.env);

let failed = false;
for (const file of ['dist/index.html', 'dist/404.html']) {
  if (!existsSync(file)) {
    console.error(`[check-build-base] missing ${file}`);
    failed = true;
    continue;
  }
  const offending = findAssetRefsOutsideBase(readFileSync(file, 'utf8'), base);
  if (offending.length > 0) {
    console.error(`[check-build-base] ${file} references paths outside the "${name}" base ${base}: ${offending.join(', ')}`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(`[check-build-base] ok: HTML references resolve under ${base} (target "${name}")`);
