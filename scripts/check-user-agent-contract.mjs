#!/usr/bin/env node
/**
 * Verifies that the user agent this app pins and the one the UI recognises still match.
 *
 * config.xml's OverrideUserAgent is load-bearing: the UI's isCordova compares
 * navigator.userAgent for EXACT equality with it. Bump the version in one repo and not the
 * other and every Cordova-specific behaviour in the shipped app silently switches off —
 * push registration, the native file chooser, the Auth0 redirect URI. Nothing errors. The
 * app just quietly becomes a plain browser.
 *
 * Reads the UI's actual file rather than a hardcoded copy, so a change on either side is
 * caught. A hardcoded expectation here would stay green while the UI drifted.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const UI_PATH = process.env.PRINT_LOG_UI_PATH
  ? resolve(process.env.PRINT_LOG_UI_PATH)
  : resolve(repoRoot, '..', '3d-print-log-ui');

const CONFIG_XML = join(repoRoot, 'config.xml');
const PLATFORM_TS = join(UI_PATH, 'src', 'app', 'core', 'utils', 'platform.ts');

function fail(message) {
  console.error(`✖ user agent contract: ${message}`);
  process.exit(1);
}

function appUserAgent() {
  const xml = readFileSync(CONFIG_XML, 'utf8');
  const match = xml.match(
    /<preference\s+name=["']OverrideUserAgent["']\s+value=["']([^"']+)["']/
  );
  if (!match) {
    fail(`no OverrideUserAgent preference found in ${CONFIG_XML}`);
  }
  return match[1];
}

function uiUserAgent() {
  const source = readFileSync(PLATFORM_TS, 'utf8');
  const match = source.match(
    /CORDOVA_USER_AGENT\s*=\s*["'`]([^"'`]+)["'`]/
  );
  if (!match) {
    fail(
      `no CORDOVA_USER_AGENT constant found in ${PLATFORM_TS}. ` +
        'The UI must export it for this check to have anything to compare against.'
    );
  }
  return match[1];
}

// A missing companion checkout is not a contract violation — it is a developer who only
// cloned one repo. Skip loudly rather than failing their build.
if (!existsSync(PLATFORM_TS)) {
  console.warn(
    `⚠ user agent contract: skipped, the UI repo is not present at ${UI_PATH}.\n` +
      '  Set PRINT_LOG_UI_PATH to check it locally.'
  );
  process.exit(0);
}

const app = appUserAgent();
const ui = uiUserAgent();

if (app !== ui) {
  fail(
    'the two repos disagree, so every Cordova-only behaviour would be off in the ' +
      'shipped app.\n' +
      `  ${CONFIG_XML}\n    OverrideUserAgent   = ${JSON.stringify(app)}\n` +
      `  ${PLATFORM_TS}\n    CORDOVA_USER_AGENT  = ${JSON.stringify(ui)}`
  );
}

console.log(`✔ user agent contract: both repos pin ${JSON.stringify(app)}`);
