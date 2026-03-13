# Project: pve-iscsi-multipath

Proxmox VE plugin adding iSCSI, Fibre Channel, and multipath SAN management to the node UI.

## Code Graph & Context

This project uses `cgc` (CodeGraphContext) to index both the plugin source and the Proxmox VE system reference files.

* **Re-index:** Run `cgc index .` whenever source files change.
* **Tools:** Use `find_code`, `analyze_code_relationships`, and `read_file` to understand logic.
* **Reference Context:**
    * `pve-context/api-backend/`: Official PVE Perl API modules (Storage, Scan, Config).
    * `pve-context/frontend/`: Official PVE UI assets (`pvemanagerlib.js`, `index.html.tpl`).

## Source Layout

- `src/perl/PVE/API2/ISCSIMultipath.pm` — all API endpoints and backend logic
- `src/js/pve-iscsi-multipath.js` — ExtJS UI panels (iSCSI, Multipath, FC tabs)
- `t/` — Perl test suite (65 tests), run with `make test`
- `debian/` — packaging scripts (postinst patches Nodes.pm and index.html.tpl)

## Build & Deploy

```bash
make deb    # builds pve-iscsi-multipath_0.3.0_all.deb
```

Three cluster nodes are available via SSH MCP servers:

| Node        | IP               | MCP server      |
|-------------|------------------|-----------------|
| cclabhost21 | 192.168.121.21   | ssh-cclabhost21 |
| cclabhost22 | 192.168.121.22   | ssh-cclabhost22 |
| cclabhost23 | 192.168.121.23   | ssh-cclabhost23 |

To deploy the `.deb` to a node, use the corresponding SSH MCP server:
1. Upload: `scp_file` or equivalent tool to copy the `.deb` to `/tmp/` on the node
2. Install: run `dpkg -i /tmp/pve-iscsi-multipath_*.deb` via the MCP `execute_command` tool
3. Restart UI: Run `systemctl restart pveproxy` to apply frontend changes.

Always prefer the SSH MCP tools over raw `ssh`/`scp` Bash commands when interacting with cluster nodes.

## Development Guidelines

1. API Consistency: Always check `pve-context/api-backend/Storage/Scan.pm` to ensure your data structures match native PVE API responses.
2. UI Patterns: Reference `pve-context/frontend/pvemanagerlib.js` for ExtJS class definitions (e.g., `PVE.storage.ConfigView`) to ensure a native look and feel.
3. Safety: Do not commit the `pve-context/` directory; it is for local AI context only and is listed in `.gitignore`.

## Branch Workflow

- Work on `dev`, PR to `main`
- Tag `main` to trigger a release: `git tag vX.Y.Z && git push origin vX.Y.Z`
- CI runs `make test` on all PRs; release workflow builds the `.deb` on tags
