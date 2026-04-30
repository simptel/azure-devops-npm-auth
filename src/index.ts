#!/usr/bin/env node
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as ini from "ini";
import { parseArgs } from "util";
import { DeviceCodeCredential, useIdentityPlugin } from "@azure/identity";
import { cachePersistencePlugin } from "@azure/identity-cache-persistence";

useIdentityPlugin(cachePersistencePlugin);

// Azure DevOps resource ID — INTENTIONALLY hardcoded, not a CLI argument.
// A hostile package.json could otherwise repurpose this tool to silently
// request a token for a different resource (e.g. Microsoft Graph) under
// the guise of "npm auth", and capture it from ~/.npmrc.
const AZDO_SCOPE = "499b84ac-1321-427f-aa17-267ca6975798/.default";
const ALLOWED_HOST = "pkgs.dev.azure.com";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HELP = `Usage: azure-devops-npm-auth [options]

  --tenant-id <guid>         Entra tenant ID         (env: AZDO_TENANT_ID)
  --client-id <guid>         Entra app client ID     (env: AZDO_CLIENT_ID)
  --project-base-path <dir>  Project root with .npmrc (default: cwd)
  -h, --help                 Show this help

Reads Azure DevOps registry URLs from <project>/.npmrc, acquires a token
via Entra device code flow, and writes _authToken entries to ~/.npmrc.`;

interface Config {
  tenantId: string;
  clientId: string;
  cwd: string;
}

function parseConfig(): Config {
  const { values } = parseArgs({
    options: {
      "tenant-id":         { type: "string" },
      "client-id":         { type: "string" },
      "project-base-path": { type: "string" },
      "help":              { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }

  const tenantId = values["tenant-id"] ?? process.env.AZDO_TENANT_ID;
  const clientId = values["client-id"] ?? process.env.AZDO_CLIENT_ID;
  const cwd = path.resolve(values["project-base-path"] ?? process.cwd());

  if (!tenantId || !GUID.test(tenantId)) {
    throw new Error("Missing or invalid --tenant-id (or AZDO_TENANT_ID). Must be a GUID.");
  }
  if (!clientId || !GUID.test(clientId)) {
    throw new Error("Missing or invalid --client-id (or AZDO_CLIENT_ID). Must be a GUID.");
  }
  if (!fs.existsSync(cwd)) throw new Error(`Path not found: ${cwd}`);
  return { tenantId, clientId, cwd };
}

function findRegistries(cwd: string): string[] {
  const npmrc = path.join(cwd, ".npmrc");
  if (!fs.existsSync(npmrc)) throw new Error(`No .npmrc found at ${npmrc}.`);

  const cfg = ini.parse(fs.readFileSync(npmrc, "utf8"));
  const found = new Set<string>();
  for (const [k, v] of Object.entries(cfg)) {
    if (typeof v !== "string") continue;
    if (k !== "registry" && !k.endsWith(":registry")) continue;

    let url: URL;
    try { url = new URL(v.trim()); } catch { continue; }

    if (url.protocol !== "https:") continue;
    if (url.hostname.toLowerCase() !== ALLOWED_HOST) continue;
    if (url.username || url.password) continue;

    found.add(url.toString());
  }
  if (!found.size) {
    throw new Error(`No https://${ALLOWED_HOST}/... registries declared in ${npmrc}.`);
  }
  return [...found];
}

interface AcquiredToken {
  value: string;
  expiresOn: Date;
}

async function acquireToken({ tenantId, clientId }: Config): Promise<AcquiredToken> {
  const cred = new DeviceCodeCredential({
    tenantId,
    clientId,
    tokenCachePersistenceOptions: {
      enabled: true,
      name: `azure-devops-npm-auth-${tenantId}`,
      unsafeAllowUnencryptedStorage: false,
    },
  });
  const result = await cred.getToken(AZDO_SCOPE);
  if (!result?.token) throw new Error("Failed to acquire access token.");
  return { value: result.token, expiresOn: new Date(result.expiresOnTimestamp) };
}

function userNpmrcPath(): string {
  return process.env.npm_config_userconfig ?? path.join(os.homedir(), ".npmrc");
}

function writeAuthTokens(registries: string[], token: string): void {
  const target = userNpmrcPath();

  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    throw new Error(`${target} is a symbolic link — refusing to write for safety.`);
  }

  const cfg = fs.existsSync(target) ? ini.parse(fs.readFileSync(target, "utf8")) : {};

  for (const registry of registries) {
    const u = new URL(registry);
    const base = `//${u.host}${u.pathname}`;
    cfg[`${base}:_authToken`] = token;
    const publish = base.replace(/\/registry\/?$/, "/");
    if (publish !== base) cfg[`${publish}:_authToken`] = token;
  }

  const tmp = `${target}.${process.pid}.tmp`;
  const contents = ini.stringify(cfg);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, "w", 0o600);
    fs.writeSync(fd, contents);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, target);
  } catch (e) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore close errors during cleanup */ }
    }
    try { fs.unlinkSync(tmp); } catch { /* ignore cleanup errors */ }
    throw e;
  }
  try { fs.chmodSync(target, 0o600); } catch { /* no-op on Windows */ }
}

function formatExpiry(expiresOn: Date): string {
  const minutes = Math.max(0, Math.round((expiresOn.getTime() - Date.now()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

async function main(): Promise<void> {
  const config = parseConfig();
  const registries = findRegistries(config.cwd);
  const token = await acquireToken(config);
  writeAuthTokens(registries, token.value);
  for (const r of registries) console.log(`✓ ${r}`);
  console.log(`Token valid for ${formatExpiry(token.expiresOn)}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});