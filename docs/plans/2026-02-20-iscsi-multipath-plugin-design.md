# PVE iSCSI/Multipath Plugin — Design Document

**Date:** 2026-02-20
**Target:** Proxmox VE 9.x (tested on 9.1.5)
**Package name:** `pve-iscsi-multipath`

---

## Problem Statement

Connecting iSCSI storage with multipath to a Proxmox cluster requires manually running a
long sequence of commands on every node: installing packages, running iscsiadm discovery,
logging into targets on each portal, writing `/etc/multipath.conf`, enabling services, and
configuring auto-login. This plugin automates the entire workflow through the Proxmox web GUI,
stopping at the point where LVM VG creation and storage pool addition are already handled
natively by Proxmox.

---

## Scope

**In scope:**
- Package installation (`open-iscsi`, `multipath-tools`, `lvm2`, `sanlock`)
- iSCSI portal management and target discovery
- iSCSI session login/logout and auto-login configuration
- Multipath configuration (`/etc/multipath.conf`) with WWID/alias management
- `lvmlockd` and `sanlock` service setup
- Node-level status and management tabs
- Datacenter-level setup wizard for cluster-wide configuration
- Graceful handling of existing/partial configurations

**Out of scope:**
- LVM VG creation (already in Proxmox GUI: Disks > LVM)
- Proxmox storage pool addition (already in Proxmox GUI: Datacenter > Storage > Add)
- Fibre Channel (future work)

---

## Architecture

### Injection Mechanism

Proxmox VE has no official plugin API. The standard community approach (used by StorPool,
PVE-mods, etc.) is:

1. Install a JavaScript file to `/usr/share/pve-manager/js/`
2. Patch `index.html.tpl` to load it via a `<script>` tag after `pvemanagerlib.js`
3. Use ExtJS `Ext.define(null, { override: 'PVE.node.Config' })` to inject tabs
4. Install a Perl API module and register it by patching `Nodes.pm`

Both patches are guarded with `# BEGIN pve-iscsi-multipath` / `# END pve-iscsi-multipath`
markers so they are idempotent and cleanly reversible.

A `dpkg trigger` on `/usr/share/pve-manager` and the relevant Perl files automatically
re-applies patches after any `pve-manager` upgrade.

---

## Package Layout

```
pve-iscsi-multipath/
├── debian/
│   ├── control          # deps: pve-manager, libpve-access-control-perl
│   ├── changelog
│   ├── rules
│   ├── compat
│   ├── triggers         # interest /usr/share/pve-manager
│   │                    # interest /usr/share/perl5/PVE/API2/Nodes.pm
│   ├── postinst         # patch index.html.tpl + Nodes.pm, restart services
│   ├── prerm            # revert both patches, restart services
│   └── postrm
├── src/
│   ├── js/
│   │   └── pve-iscsi-multipath.js   → /usr/share/pve-manager/js/
│   └── perl/
│       └── PVE/API2/
│           └── ISCSIMultipath.pm    → /usr/share/perl5/PVE/API2/
└── Makefile
```

### Runtime File Changes

**`/usr/share/pve-manager/index.html.tpl`** — one `<script>` tag inserted after
`pvemanagerlib.js`:

```html
<!-- BEGIN pve-iscsi-multipath -->
<script type="text/javascript" src="/pve2/js/pve-iscsi-multipath.js?ver=VERSION"></script>
<!-- END pve-iscsi-multipath -->
```

**`/usr/share/perl5/PVE/API2/Nodes.pm`** — two insertions in the `Nodeinfo` class section:

```perl
# BEGIN pve-iscsi-multipath
use PVE::API2::ISCSIMultipath;
# END pve-iscsi-multipath
```

```perl
# BEGIN pve-iscsi-multipath
__PACKAGE__->register_method({
    subclass => "PVE::API2::ISCSIMultipath",
    path => 'iscsi',
});
# END pve-iscsi-multipath
```

`postinst` verifies the expected surrounding lines exist before patching. If verification
fails (Proxmox changed the file in an unexpected way), the install aborts with a clear error
rather than corrupting the file.

---

## Backend API

All endpoints are under `/nodes/{node}/iscsi/`. Required permission: `Sys.Modify` on the
node. All responses follow standard Proxmox JSON conventions.

### Status

```
GET /nodes/{node}/iscsi/status
```

Returns the current state of all relevant packages and services. Called on wizard open and
on node tab load.

```json
{
  "packages": {
    "open_iscsi": true,
    "multipath_tools": true,
    "lvm2": true,
    "sanlock": false
  },
  "services": {
    "iscsid":    { "running": true,  "enabled": true  },
    "multipathd": { "running": true,  "enabled": true  },
    "lvmlockd":  { "running": false, "enabled": false },
    "sanlock":   { "running": false, "enabled": false }
  },
  "sessions": [
    { "target_iqn": "iqn.2005-10.org.freenas.ctl:proxmox-bruce",
      "portal": "192.168.122.15:3260", "state": "LOGGED_IN" }
  ],
  "multipath_config_exists": true,
  "multipath_devices": [
    { "alias": "proxmox-bruce", "wwid": "36589cfc000...", "paths": 2, "state": "active" }
  ]
}
```

### Discovery & Sessions

```
POST /nodes/{node}/iscsi/discover
  params: portals (array of "IP" or "IP:port")
  returns: [{ target_iqn, portal, tpgt }]
  note: runs iscsiadm -m discovery -t sendtargets against each portal

GET  /nodes/{node}/iscsi/sessions
  returns: current active sessions (same shape as status.sessions)

POST /nodes/{node}/iscsi/login
  params: target_iqn (string), portal (string)
  returns: { already_connected: bool } or taskid
  note: no-ops silently if session already exists

POST /nodes/{node}/iscsi/logout
  params: target_iqn (string), portal (string)
  returns: taskid

PUT  /nodes/{node}/iscsi/startup
  params: target_iqn (string), mode ("automatic" | "manual" | "onboot")
  note: sets node.startup via iscsiadm --op update
```

### Multipath

```
GET  /nodes/{node}/iscsi/multipath/status
  returns: parsed multipath -ll output as structured objects
  [{ alias, wwid, paths: [{ dev, state, dm_status }] }]

GET  /nodes/{node}/iscsi/multipath/config
  returns: { content: "<raw /etc/multipath.conf>" }

PUT  /nodes/{node}/iscsi/multipath/config
  params: content (string), merge (bool)
  returns: taskid (writes config and restarts multipathd)
  note: if merge=true, appends new multipaths{} entries to existing config
        without touching defaults{} or blacklist{} sections
```

### Wizard Setup (Bulk)

```
POST /nodes/{node}/iscsi/setup
  params:
    portals              (array of strings)
    targets              (array of target_iqn strings)
    multipath_config     (string — full multipath.conf content)
    merge_multipath      (bool — merge vs replace existing config)
    enable_lvmlockd      (bool)
    enable_sanlock       (bool)
  returns: taskid

  Behavior (each step is skipped if already satisfied):
    1. apt-get install open-iscsi multipath-tools lvm2 [sanlock]
    2. systemctl enable --now iscsid
    3. For each portal × target: iscsiadm discover + login (skip if session exists)
    4. Write or merge /etc/multipath.conf
    5. systemctl enable --now multipathd && multipathd reconfigure
    6. If enable_lvmlockd: apt-get install lvm2 sanlock,
                           patch /etc/lvm/lvm.conf,
                           systemctl enable --now lvmlockd sanlock
    7. Configure auto-login: iscsiadm --op update node.startup=automatic
                             for all target+portal pairs
```

All setup steps are logged to the Proxmox task log so output streams live into the wizard's
progress panel.

---

## Frontend (JavaScript / ExtJS 7)

### Injection Point

`pve-iscsi-multipath.js` is loaded after `pvemanagerlib.js`. It uses:

```javascript
Ext.define(null, {
    override: 'PVE.node.Config',
    initComponent: function() {
        this.callParent(arguments);
        // me.add([...]) to inject tabs after parent initializes
    }
});
```

### Node-Level Tabs

Both tabs are injected into the `storage` group (alongside LVM, ZFS, etc.):

```javascript
{ xtype: 'pveISCSIPanel',    title: 'iSCSI',     itemId: 'iscsi',
  iconCls: 'fa fa-plug',     groups: ['storage'], nodename: nodename }
{ xtype: 'pveMultipathPanel', title: 'Multipath', itemId: 'multipath',
  iconCls: 'fa fa-sitemap',  groups: ['storage'], nodename: nodename }
```

**`PVE.node.ISCSIPanel`**
- Toolbar: Reload, Add Portal, Discover Targets
- Two grids:
  - Left: Portals (IP, port) — Add/Remove buttons
  - Right: Sessions (target IQN, portal, state) — Login/Logout buttons per row
- Bottom: auto-login toggle per target

**`PVE.node.MultipathPanel`**
- Status grid: alias, WWID, path count, state — from `GET .../multipath/status`
- Toolbar: Reload, Edit Config, Restart Service
- "Edit Config" opens a modal textarea pre-loaded from `GET .../multipath/config`, saves via `PUT`

### Datacenter Wizard

`PVE.dc.ISCSISetupWizard` extends `Proxmox.window.Wizard`. Accessed via a "SAN Setup" button
injected into the Datacenter storage panel toolbar (exact xtype to be confirmed during
implementation via `grep` on `pvemanagerlib.js`).

#### Step 1: Select Nodes

Checkbox list of cluster nodes. On selection change, fires `GET .../iscsi/status` for each
checked node. Displays a status badge per node:

| Badge  | Meaning |
|--------|---------|
| Green  | Fully configured |
| Yellow | Partial (some steps done) |
| Orange | Packages missing |
| Red    | Not configured |

Fully-green nodes show: *"Already configured — wizard will only apply missing steps."*

#### Step 2: Portals

Table with Add/Remove rows. Enter one or more portal IPs (e.g., `192.168.122.15`,
`192.168.123.15`). Multiple portals enable multipath. Port defaults to 3260.

#### Step 3: Discover & Select Targets

"Discover" button fires `POST .../iscsi/discover` on the first selected node against all
entered portals. Returns a list of target IQNs as checkboxes. Targets already logged in
on a node are pre-checked and labeled *"already connected"*.

#### Step 3→4 Transition (Login)

On clicking Next from step 3, the wizard performs iSCSI logins for *newly selected* targets
only (skips already-connected sessions). Shows a progress panel per portal × target.
Tracks which logins this wizard session performed — the Back button from step 4 only logs
out those new sessions, leaving pre-existing sessions untouched.

#### Step 4: Multipath Configuration

- If `/etc/multipath.conf` already exists on any selected node: shows a **Merge / Replace**
  toggle (defaults to Merge)
  - **Merge**: existing entries shown read-only; new WWID/alias rows added below
  - **Replace**: full editor, existing content pre-populated as starting point
- WWIDs sourced from both pre-existing `multipath_devices` (from status call) and
  newly logged-in targets (from `GET .../multipath/status` after login step)
- Each row: WWID (read-only), Alias (editable text field)
- Preview pane shows generated `multipath.conf` content live

#### Step 5: Services

Checkboxes:
- "Enable iscsid" (pre-checked if already running, disabled with *"already enabled"* note)
- "Enable multipathd" (same)
- "Enable lvmlockd" (pre-checked for clusters; unchecked for single-node)
- "Enable sanlock" (same as lvmlockd)

Single-node vs. cluster detection via existing `/cluster/status` API.

#### Step 6: Apply

Fires `POST /nodes/{node}/iscsi/setup` sequentially for each selected node. Shows a
collapsible per-node section with live task log output. Skipped steps appear as
*"skipped (already configured)"* in the log for transparency.

On completion, shows a summary with links to Disks > LVM and Datacenter > Storage > Add
for the next steps (VG creation and storage pool addition).

---

## Error Handling

- `postinst` patch verification: if expected surrounding lines are not found, abort with
  a clear error message and leave files unmodified
- `prerm` reverts patches using the `BEGIN`/`END` markers; safe to run even if patches
  were never applied
- Wizard surfaces per-step error messages inline, not just a generic alert
- `POST .../iscsi/setup` task logs show exactly which step failed and why
- `POST .../iscsi/login` returns `already_connected: true` rather than an error if the
  session already exists — the wizard treats this as success

---

## Open Questions for Implementation

1. **Exact xtype of the Datacenter storage panel** — needs `grep -n "Ext\.define.*Storage\|Datacenter.*Storage"` on `pvemanagerlib.js` to confirm the class to override for the "SAN Setup" button injection.

2. **Exact location of `Nodeinfo` class boundary in `Nodes.pm`** — needs `grep -n "^package"` to confirm which `register_method` block belongs to `Nodeinfo` vs the outer `Nodes` class (preliminary evidence: lines 111–201 are `Nodeinfo` subhandlers).

3. **WWID detection method** — `multipath -ll` after login is the primary method; fallback to reading `/sys/block/sdX/device/wwid` if multipathd isn't running yet.

---

## Not Addressed (Future Work)

- Fibre Channel support
- Per-node multipath.conf divergence detection (nodes having different configs)
- Import/export of portal/target configuration as a cluster-wide profile
