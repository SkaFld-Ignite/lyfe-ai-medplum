// Entry point used by cdk.json instead of running src/index.ts directly.
//
// src/index.ts only calls main() when `import.meta.main` is true, but that
// field isn't populated until Node 24+ (we're on Node 22 here), so the CDK
// CLI's own app subprocess silently does nothing -- no manifest gets
// written, context lookups (like real availability zones) never resolve,
// and every command from `cdk synth` to `cdk deploy` fails or synthesizes
// with placeholder values. Calling main() directly sidesteps that check
// without touching the upstream Medplum source file.
import { main } from './src/index.ts';

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
