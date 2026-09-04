// Fails the build if a developer-tools chunk made it into production output.
//
// The /dev routes are gated by a build-time literal (see vite.config.ts), so a
// default production build must emit no chunk for any of them. A build that
// opts in with VITE_ENABLE_DEV_TOOLS=true is expected to contain them and is
// skipped here.
import { readdirSync } from 'node:fs';

const DEV_CHUNKS = ['TestLabPage', 'WorldEditorPage', 'InventoryPanelPage', 'DevLayout'];

if (process.env.VITE_ENABLE_DEV_TOOLS === 'true') {
  console.log('[check-dev-chunks] dev tools enabled for this build; skipping');
  process.exit(0);
}

const files = readdirSync('dist/assets');
const leaked = files.filter((file) => DEV_CHUNKS.some((name) => file.includes(name)));

if (leaked.length > 0) {
  console.error(`[check-dev-chunks] developer chunks found in a production build: ${leaked.join(', ')}`);
  process.exit(1);
}
console.log(`[check-dev-chunks] ok: no developer chunk among ${files.length} assets`);
