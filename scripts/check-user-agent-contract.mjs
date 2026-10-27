#!/usr/bin/env node
/**
 * Verifies that the user agents this app pins and the ones the UI recognizes still match.
 *
 * config.xml's OverrideUserAgent is load-bearing: the UI's isCordova compares
 * navigator.userAgent for EXACT equality with it. Bump the version in one repo and not the
 * other and every Cordova-specific behavior in the shipped app silently switches off —
 * push registration, the native file chooser, the Auth0 redirect URI. Nothing errors. The
 * app just quietly becomes a plain browser.
 *
 * There are two pairs. Android uses the global preference; iOS overrides it inside
 * <platform name="ios">, because the UI must tell the shells apart (App Store rules force
 * iOS-only behavior). The iOS block comes first in the file, so "the first
 * OverrideUserAgent" would be the iOS one: each value is read from its own scope.
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

const CONFIG_XML = process.env.PRINT_LOG_CONFIG_XML
  ? resolve(process.env.PRINT_LOG_CONFIG_XML)
  : join(repoRoot, 'config.xml');
const PLATFORM_TS = join(UI_PATH, 'src', 'app', 'core', 'utils', 'platform.ts');

const PLATFORM_BLOCK = /<platform\s+name=["']([^"']+)["']\s*>[\s\S]*?<\/platform>/g;
const COMMENT = /<!--[\s\S]*?-->/g;
const OVERRIDE_USER_AGENT =
  /<preference\s+name=["']OverrideUserAgent["']\s+value=["']([^"']+)["']/g;

function fail(message) {
  console.error(`✖ user agent contract: ${message}`);
  process.exit(1);
}

function spans(regex, text) {
  return [...text.matchAll(regex)].map((m) => ({
    name: m[1],
    start: m.index,
    end: m.index + m[0].length,
  }));
}

function appUserAgents() {
  // Each preference is placed by where it sits in the file rather than by cutting the text
  // up: a comment can quote a preference, so one inside a comment is skipped, and one
  // inside a <platform> block belongs to that platform. Nothing is stripped from the text.
  const xml = readFileSync(CONFIG_XML, 'utf8');
  const comments = spans(COMMENT, xml);
  const inComment = (i) => comments.some((c) => i >= c.start && i < c.end);
  const blocks = spans(PLATFORM_BLOCK, xml).filter((b) => !inComment(b.start));

  const scopes = {};
  for (const { name: value, start } of spans(OVERRIDE_USER_AGENT, xml)) {
    if (inComment(start)) {
      continue;
    }
    const scope = blocks.find((b) => start >= b.start && start < b.end)?.name ?? 'global';
    if (scope in scopes) {
      fail(`more than one OverrideUserAgent in the same scope of ${CONFIG_XML}`);
    }
    scopes[scope] = value;
  }

  const android = scopes.android ?? scopes.global;
  const ios = scopes.ios ?? scopes.global;
  if (!android || !ios) {
    fail(`no OverrideUserAgent for ${android ? 'iOS' : 'Android'} in ${CONFIG_XML}`);
  }
  return { android, ios };
}

function uiConstant(source, name) {
  const match = source.match(
    new RegExp(`\\b${name}\\s*=\\s*["'\`]([^"'\`]+)["'\`]`)
  );
  if (!match) {
    fail(
      `no ${name} constant found in ${PLATFORM_TS}. ` +
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

const app = appUserAgents();
const source = readFileSync(PLATFORM_TS, 'utf8');
const ui = {
  android: uiConstant(source, 'CORDOVA_USER_AGENT'),
  ios: uiConstant(source, 'CORDOVA_IOS_USER_AGENT'),
};

if (app.android === app.ios) {
  fail(
    `Android and iOS both pin ${JSON.stringify(app.android)}, so the UI cannot tell ` +
      'the shells apart. iOS needs its own OverrideUserAgent in <platform name="ios">.'
  );
}

const mismatches = [
  ['Android', 'OverrideUserAgent', 'CORDOVA_USER_AGENT', app.android, ui.android],
  [
    'iOS',
    'OverrideUserAgent (ios)',
    'CORDOVA_IOS_USER_AGENT',
    app.ios,
    ui.ios,
  ],
].filter(([, , , pinned, recognized]) => pinned !== recognized);

if (mismatches.length > 0) {
  fail(
    'the two repos disagree, so every Cordova-only behavior would be off in the ' +
      'shipped app.\n' +
      mismatches
        .map(
          ([platform, appName, uiName, pinned, recognized]) =>
            `  ${platform}:\n` +
            `    ${CONFIG_XML}\n      ${appName} = ${JSON.stringify(pinned)}\n` +
            `    ${PLATFORM_TS}\n      ${uiName} = ${JSON.stringify(recognized)}`
        )
        .join('\n')
  );
}

console.log(
  `✔ user agent contract: Android pins ${JSON.stringify(app.android)}, ` +
    `iOS pins ${JSON.stringify(app.ios)}, and the UI recognizes both`
);
