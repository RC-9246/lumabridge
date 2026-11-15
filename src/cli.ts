#!/usr/bin/env node
import { ConfigError, loadConfig } from './config.js';
import { OneBotProbeError, probeOneBot } from './onebot-http.js';

const usage = `lumabridge doctor — read-only OneBot HTTP diagnostics

Usage: lumabridge --config <file>
       pnpm run doctor --config ./lumabridge.local.json

Calls only get_version_info, get_status and get_login_info.
No login, messages, configuration changes, retries or failover.
Tokens come from the environment variable named by backend.tokenEnv.
Account IDs are redacted in CLI output.

Exit codes: 0 = online and good; 2 = reachable but unhealthy/unknown;
            1 = invalid config, arguments or failed probe.
`;

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && ['--help', '-h'].includes(args[0]!))) {
    process.stdout.write(usage);
    return 0;
  }
  if (args.length !== 2 || args[0] !== '--config' || !args[1] || args[1].startsWith('--')) {
    process.stderr.write('INVALID_ARGUMENTS: Use --config <file> or --help.\n');
    return 1;
  }
  try {
    const config = await loadConfig(args[1]);
    const report = await probeOneBot(config);
    const printable = { ...report, ...(report.account ? { account: { id: '[redacted]' } } : {}) };
    process.stdout.write(`${JSON.stringify(printable, null, 2)}\n`);
    return report.health.online === true && report.health.good === true ? 0 : 2;
  } catch (error) {
    if (error instanceof ConfigError || error instanceof OneBotProbeError) {
      process.stderr.write(`${error.code}: ${error.message}\n`);
    } else {
      process.stderr.write('INTERNAL_ERROR: Diagnostic failed.\n');
    }
    return 1;
  }
}

process.exitCode = await main();
