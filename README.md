# pve-iscsi-multipath

A plugin for Proxmox VE that adds iSCSI, Fibre Channel, and multipath SAN management directly to the node UI. It injects additional tabs into each node's panel and exposes a set of API endpoints on `/nodes/{node}/iscsi/multipath/`.

**This is experimental software. Do not use it in production.**

## What it does

Each node gets four new tabs in the Proxmox web UI:

- **iSCSI** — discover targets, manage sessions, set auto-login startup mode, install the open-iscsi package
- **Multipath** — view active multipath devices and path counts, edit multipath.conf inline, add WWID/alias entries, install multipath-tools
- **FC** — list local Fibre Channel HBAs and fabric targets visible through them, trigger LIP rescan
- **LVM** — set up a new LVM volume group on a multipath device and register it as shared Proxmox storage; trigger LVM discovery on secondary nodes after setup on the primary

The Configure Multipath button (available from both the iSCSI and FC tabs) walks through WWID detection for a selected target and adds the appropriate entry to multipath.conf.

## Requirements

- Proxmox VE 9.0 or later
- Root access to install the package on each node

The following packages are optional at install time but required for actual use:

- `open-iscsi` — for iSCSI session management
- `multipath-tools` — for multipath device management
- `lvm2` — for LVM setup

These can be installed from the iSCSI and Multipath tabs in the UI after the plugin is installed.

## Building

```bash
make deb
```

This produces `pve-iscsi-multipath_0.2.0_all.deb` in the project root. Requires `dpkg-deb` (standard on any Debian/Ubuntu system).

To run the test suite:

```bash
make test
```

55 tests covering session/discovery parsing, multipath config merging, WWID detection, FC HBA parsing, and setup idempotency.

## Installing

Copy the `.deb` to each node and install it:

```bash
scp pve-iscsi-multipath_0.2.0_all.deb root@<node>:/tmp/
ssh root@<node> dpkg -i /tmp/pve-iscsi-multipath_0.2.0_all.deb
```

The postinstall script patches `Nodes.pm` and `index.html.tpl` to inject the plugin, then triggers a pve-manager reload. Hard-refresh the browser after installing on each node (`Ctrl+Shift+R`).

For a three-node cluster, repeat for each node. The API endpoints are node-local (`proxyto => 'node'`), so each node needs its own installation.

## Uninstalling

```bash
dpkg -r pve-iscsi-multipath
```

The prerm script removes the patches from `Nodes.pm` and `index.html.tpl` before uninstalling. The plugin leaves no other files behind.

## API

All endpoints sit under `/api2/json/nodes/{node}/iscsi/multipath/` and use standard PVE authentication and permissions (`Sys.Audit` for read operations, `Sys.Modify` for write operations). Any existing PVE auth method works — username/password, API tokens, etc.

Notable endpoints:

| Method | Path | Description |
|--------|------|-------------|
| GET | `status` | iSCSI sessions, multipath devices, package/service status, FC HBA info |
| POST | `discover` | Run sendtargets discovery against one or more portals |
| POST | `login` | Login to an iSCSI target |
| POST | `logout` | Logout from an iSCSI target |
| GET | `multipath/wwid` | Detect WWID for an iSCSI or FC target |
| GET | `multipath/config` | Read /etc/multipath.conf |
| PUT | `multipath/config` | Write /etc/multipath.conf and restart multipathd |
| POST | `multipath/add-device` | Add a WWID+alias block to multipath.conf |
| POST | `lvm-setup` | Create PV/VG on a multipath device and register as Proxmox storage |
| POST | `lvm-scan` | Run pvscan --cache + vgchange -ay to discover VGs on secondary nodes |
| GET | `fc/hbas` | List local FC HBAs |
| GET | `fc/targets` | List FC fabric targets |
| POST | `fc/rescan` | Trigger LIP on all local FC HBAs |

## Caveats

- Tested on Proxmox VE 9.1 with iSCSI targets on TrueNAS. FC support exists in the UI but has not been tested against real hardware.
- The postinstall script patches Proxmox internals (`Nodes.pm`, `index.html.tpl`). A Proxmox update may overwrite these files, which would require reinstalling the package.
- LVM setup is intentionally minimal — it creates a PV and VG and registers the storage. It does not configure lvmlockd or sanlock; Proxmox's built-in cluster stack handles coordination for shared LVM.

## License

MIT
