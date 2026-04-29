#!/usr/bin/env node
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseArgs } from "node:util";
import * as ini from "ini";
import { useIdentityPlugin, InteractiveBrowserCredential } from "@azure/identity";

// ADO service ID is fixed globally, owned by Microsoft.
const AZURE_DEVOPS_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
const DEFAULT_SCOPE = "vso.packaging";
const ADO_HOST = "pkgs.dev.azure.com";

const CONFIG_DIR = path.join(os.homedir(), ".config", "azure-devops-npm-auth");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const PROJECT_NPMRC = path.join(process.cwd(), ".npmrc");
const USER_NPMRC = path.join(os.homedir(), ".npmrc");

type NpmrcConfig = Record<string, unknown>;
type OrgConfig = { tenantId: string; clientId: string; scope?: string };
type AppConfig = { orgs: Record<string, OrgConfig> };

const HELP_TEXT = `
azure-devops-npm-auth — Entra ID auth for Azure DevOps npm feeds

USAGE
  azure-devops-npm-auth [options]

OPTIONS
  --tenant-id <id>      Entra tenant ID (required on first run for an org)
  --client-id <id>      Entra app registration client ID (required on first run)
  --scope <scope>       ADO scope (default: vso.packaging)
  --org <name>          ADO organization (default: auto-detect from project .npmrc)
  --logout              Clear cached config for the org and exit
  --help                Show this message

FIRST RUN
  cd <project-with-.npmrc>
  azure-devops-npm-auth --tenant-id <tenant> --client-id <client>

SUBSEQUENT RUNS
  azure-devops-npm-auth

CONFIG
  Persisted to ~/.config/azure-devops-npm-auth/config.json, keyed by
  ADO organization. Each org has its own Keychain cache entry.
`.trim();

function readNpmrc(filePath: string): NpmrcConfig {
  return fs.existsSync(filePath) ? ini.parse(fs.readFileSync(filePath, "utf8")) : {};
}

function readAppConfig(): AppConfig {
  if (!fs.existsSync(CONFIG_FILE)) return { orgs: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return raw && typeof raw === "object" && raw.orgs ? raw : { orgs: {} };
  } catch {
    return { orgs: {} };
  }
}

function writeAppConfig(cfg: AppConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(cfg, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, CONFIG_FILE);
}

/**
 * ADO npm registry URLs follow:
 *   https://pkgs.dev.azure.com/<org>/_packaging/<feed>/npm/registry/
 *   https://pkgs.dev.azure.com/<org>/<project>/_packaging/<feed>/npm/registry/
 * The org is the first path segment after the host.
 */
function extractOrgFromRegistry(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.host !== ADO_HOST) return null;
    const segments = u.pathname.split("/").filter(Boolean);
    return segments.length > 0 ? segments[0] : null;
  } catch {
    return null;
  }
}

function findAdoRegistries(cfg: NpmrcConfig): string[] {
  return Object.entries(cfg)
    .filter(([k, v]) => typeof v === "string" && (k === "registry" || k.endsWith(":registry"))
                        && extractOrgFromRegistry(v) !== null)
    .map(([, v]) => v as string);
}

function authKeysForRegistry(registry: string): string[] {
  const { host, pathname } = new URL(registry);
  const base = `//${host}${pathname}`;
  const publish = base.replace(/\/registry\/?$/, "/");
  return publish === base ? [`${base}:_authToken`] : [`${base}:_authToken`, `${publish}:_authToken`];
}

function isExpired(token: string): boolean {
  try {
    const { exp } = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());
    return typeof exp !== "number" || exp * 1000 <= Date.now();
  } catch {
    return true;
  }
}

function hasValidTokens(cfg: NpmrcConfig, registries: string[]): boolean {
  return registries.every(r =>
    authKeysForRegistry(r).every(k => typeof cfg[k] === "string" && !isExpired(cfg[k] as string))
  );
}

let cachePluginRegistered = false;
async function registerCachePlugin(): Promise<void> {
  if (cachePluginRegistered) return;
  const { cachePersistencePlugin } = await import("@azure/identity-cache-persistence");
  useIdentityPlugin(cachePersistencePlugin);
  cachePluginRegistered = true;
}

async function acquireToken(org: string, orgCfg: OrgConfig): Promise<string> {
  await registerCachePlugin();
  const scope = `${AZURE_DEVOPS_RESOURCE}/${orgCfg.scope ?? DEFAULT_SCOPE}`;
  const cred = new InteractiveBrowserCredential({
    tenantId: orgCfg.tenantId,
    clientId: orgCfg.clientId,
    redirectUri: "http://localhost",
    tokenCachePersistenceOptions: { enabled: true, name: `azure-devops-npm-auth-${org}` },
  });
  const { token } = await cred.getToken(scope);
  return token;
}

function applyTokenToConfig(cfg: NpmrcConfig, registries: string[], token: string): void {
  for (const r of registries) {
    for (const k of authKeysForRegistry(r)) cfg[k] = token;
  }
}

function writeNpmrcAtomic(filePath: string, cfg: NpmrcConfig): void {
  const tmp = `${filePath}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, ini.stringify(cfg));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "tenant-id":     { type: "string" },
      "client-id":     { type: "string" },
      "scope":         { type: "string" },
      "org":           { type: "string" },
      "logout":        { type: "boolean", default: false },
      "help":          { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(HELP_TEXT);
    return;
  }

  const project = readNpmrc(PROJECT_NPMRC);
  const registries = findAdoRegistries(project);

  // Logout doesn't need a project .npmrc — let it run anywhere.
  if (values.logout) {
    const appCfg = readAppConfig();
    const orgsToClear: string[] = values.org
      ? [values.org]
      : (registries.length > 0
          ? Array.from(new Set(registries.map(extractOrgFromRegistry).filter((o): o is string => o !== null)))
          : Object.keys(appCfg.orgs));
    if (orgsToClear.length === 0) fail("No org to log out of. Pass --org <name>.");
    for (const o of orgsToClear) delete appCfg.orgs[o];
    writeAppConfig(appCfg);
    console.log(`✓ Cleared config for: ${orgsToClear.join(", ")}`);
    console.log(`  (Keychain entries persist; remove via Keychain Access if needed.)`);
    return;
  }

  if (registries.length === 0) {
    fail(`No Azure DevOps registries (${ADO_HOST}/...) found in ${PROJECT_NPMRC}.`);
  }

  // Group registries by org. Most projects have one org; we support several.
  const registriesByOrg = new Map<string, string[]>();
  for (const r of registries) {
    const org = extractOrgFromRegistry(r)!;
    const list = registriesByOrg.get(org) ?? [];
    list.push(r);
    registriesByOrg.set(org, list);
  }

  // Resolve which org(s) to authenticate. --org narrows; otherwise all detected orgs.
  const targetOrgs = values.org
    ? (registriesByOrg.has(values.org)
        ? [values.org]
        : fail(`--org ${values.org} not found among project registries: ${[...registriesByOrg.keys()].join(", ")}`))
    : [...registriesByOrg.keys()];

  // CLI flags update config when provided. Require both together.
  const appCfg = readAppConfig();
  if (values["tenant-id"] || values["client-id"] || values["scope"]) {
    if (!values["tenant-id"] || !values["client-id"]) {
      fail("--tenant-id and --client-id must be provided together.");
    }
    if (targetOrgs.length !== 1) {
      fail(`Pass --org explicitly when registering credentials and the project references multiple orgs (${targetOrgs.join(", ")}).`);
    }
    const org = targetOrgs[0];
    appCfg.orgs[org] = {
      tenantId: values["tenant-id"],
      clientId: values["client-id"],
      ...(values["scope"] ? { scope: values["scope"] } : {}),
    };
    writeAppConfig(appCfg);
    console.log(`✓ Saved config for ${org}`);
  }

  // Make sure every target org has config.
  for (const org of targetOrgs) {
    if (!appCfg.orgs[org]) {
      fail(
        `No config for ${org}. Run once with credentials:\n` +
        `  azure-devops-npm-auth --tenant-id <id> --client-id <id>` +
        (targetOrgs.length > 1 ? ` --org ${org}` : "")
      );
    }
  }

  // Skip auth if every relevant token in ~/.npmrc is still valid.
  const userCfg = readNpmrc(USER_NPMRC);
  if (hasValidTokens(userCfg, registries)) return;

  // Authenticate per org and apply tokens to all that org's registries.
  const authedOrgs: string[] = [];
  for (const org of targetOrgs) {
    const orgRegistries = registriesByOrg.get(org)!;
    if (hasValidTokens(userCfg, orgRegistries)) continue;
    const token = await acquireToken(org, appCfg.orgs[org]);
    applyTokenToConfig(userCfg, orgRegistries, token);
    authedOrgs.push(org);
  }

  if (authedOrgs.length === 0) return;

  writeNpmrcAtomic(USER_NPMRC, userCfg);

  console.log(`✓ Authenticated for ${authedOrgs.length} org${authedOrgs.length === 1 ? "" : "s"}:`);
  for (const org of authedOrgs) {
    for (const r of registriesByOrg.get(org)!) console.log(`  • ${r}`);
  }
}

main().catch((e) => fail(e?.message ?? String(e)));
