# azure-devops-npm-auth

Authenticate `npm` with Azure DevOps Artifacts using Microsoft Entra ID.
Replaces Personal Access Tokens (PATs) with short-lived tokens.

---

## Prerequisites

Register an OAuth2 app in Microsoft Entra ID:

1. Entra admin center → **App registrations** → **New registration**
2. **Supported account types**: Single tenant
3. **Redirect URI**: leave empty (device code flow doesn't use one)
4. After creation → **Authentication** → enable **Allow public client flows**
5. **API permissions** → **Add a permission** → **Azure DevOps** → **Delegated** → `vso.packaging` (and `vso.packaging_write` if publishing)
6. Grant admin consent
7. Copy the **Application (client) ID** and **Directory (tenant) ID** from the Overview page

---

## Install

```bash
npm install -g azure-devops-npm-auth
```

---

## Usage

Run in a project with an Azure DevOps `.npmrc`:

```bash
azure-devops-npm-auth --tenant-id <tenant-id> --client-id <client-id>
```

On first run:

* Opens browser for sign-in
* Stores auth session securely in OS keychain
* Writes access token to `~/.npmrc`

Subsequent runs:

```bash
azure-devops-npm-auth
```

Runs silently and refreshes tokens when needed.

---

## Features

* Entra ID authentication (no PATs)
* Automatic token refresh
* Multi-registry support
* Works with existing `.npmrc`
* Safe to run before every `npm install`

---

## How it works

* Uses Entra ID to obtain an access token for Azure DevOps
* Stores session securely via OS credential storage (Keychain / DPAPI / libsecret)
* Writes short-lived token to `~/.npmrc` for npm usage

---

## Notes

* Tokens expire (~1 hour) and are refreshed automatically
* Requires an Entra app registration with `vso.packaging` permission

---

## License

MIT License
