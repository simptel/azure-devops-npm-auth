#!/usr/bin/env node
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as ini from "ini";
import { parseArgs } from "util";
import {
  ChainedTokenCredential,
  AzureCliCredential,
  DeviceCodeCredential,
  useIdentityPlugin,
} from "@azure/identity";
import { cachePersistencePlugin } from "@azure/identity-cache-persistence";

useIdentityPlugin(cachePersistencePlugin);

// Azure DevOps resource ID — INTENTIONALLY hardcoded, not a CLI argument.
// A hostile package.json could otherwise repurpose this tool to silently
// request a token for a different resource (e.g. Microsoft Graph) under
// the guise of "npm auth", and capture it from ~/.npmrc.
const AZDO_SCOPE = "499b84ac-1321-427f-aa17-267ca6975798/.default";
const ALLOWED_HOST = "pkgs.dev.azure.com";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Config { tenantId: string; clientId: string; cwd: string; }

function parseConfig(): Config {
  const { values } = parseArgs({
    options: {
      "tenant-id":         { type: "string" },
      "client-id":         { type: "string" },
      "project-base-path": { type: "string" },
    },
    strict: false,
    allowPositionals: true,
  });

  const tenantId = (values["tenant-id"] as string | undefined) ?? process.env.AZDO_TENANT_ID;
  const clientId = (values["client-id"] as string | undefined) ?? process.env.AZDO_CLIENT_ID;
  const cwd = path.resolve((values["project-base-path"] as string | undefined) ?? process.cwd());

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

async function acquireToken({ tenantId, clientId }: Config): Promise<string> {
  const cred = new ChainedTokenCredential(
    new AzureCliCredential({ tenantId }),
    new DeviceCodeCredential({
      tenantId,
      clientId,
      tokenCachePersistenceOptions: {
        enabled: true,
        name: `azure-devops-npm-auth-${tenantId}`,
        unsafeAllowUnencryptedStorage: false,
      },
    }),
  );
  const result = await cred.getToken(AZDO_SCOPE);
  if (!result?.token) throw new Error("Failed to acquire access token.");
  return result.token;
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
  fs.writeFileSync(tmp, ini.stringify(cfg), { mode: 0o600 });
  fs.renameSync(tmp, target);
  try { fs.chmodSync(target, 0o600); } catch { /* no-op on Windows */ }
}

async function main(): Promise<void> {
  const config = parseConfig();
  const registries = findRegistries(config.cwd);
  const token = await acquireToken(config);
  writeAuthTokens(registries, token);
  for (const r of registries) console.log(`✓ ${r}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
