# Configure Multipath Feature Design

Date: 2026-02-27

## Goal

Allow a user to select an iSCSI session or FC target in the GUI, click "Configure Multipath",
and assign an alias to the corresponding multipath device. The WWID is auto-detected from
the selection; the user only needs to provide the alias.

## User Flow

1. User selects a row in the Sessions grid (iSCSI tab) or FC Targets grid (FC tab)
2. Clicks "Configure Multipath" button (disabled when no row selected)
3. Dialog opens with a loading spinner; fires GET to discover WWID
4. If WWID not found: error alert, dialog closes
5. If WWID already configured: error alert showing existing alias, dialog closes
6. If WWID found and unconfigured: form shows WWID (read-only) + alias text input
7. User enters alias, clicks Submit
8. POST adds the multipath block; `multipathd reconfigure` runs; dialog closes

## Architecture

```
User selects session/FC target
         │
         ▼
"Configure Multipath" button (enabled only when a row is selected)
         │
         ▼
Dialog opens → GET /iscsi/multipath/wwid?target_iqn=...&portal=...
                                      (or ?fc_wwpn=...)
         │
         ├── WWID not found → error: "No multipath device detected for this target"
         ├── already_configured → error: "Already configured as 'alias_name'"
         └── WWID found → show form: WWID (read-only) + alias text field
                                  │
                                  ▼
                          POST /iscsi/multipath/add-device {wwid, alias}
                                  │
                                  └── writes block via merge_multipath_config
                                      runs `multipathd reconfigure`
```

## Backend

### WWID Detection

WWID is found by correlating through `multipath -ll` path entries (format: `H:B:T:L sdX ...`)
using the host number as the join key.

**iSCSI path:**
- Parse `iscsiadm -m session -P 3` → find session matching `target_iqn` + `portal`
- Extract "Host Number: H"
- Scan `multipath -ll` for a path entry starting with `H:` → return that device's WWID

**FC path:**
- Scan `/sys/class/fc_remote_ports/rport-H:B-I/port_name` for matching WWPN
- Extract host number `H` from the rport directory name
- Scan `multipath -ll` paths for `H:` → return WWID

### New Endpoints

**`GET /nodes/{node}/iscsi/multipath/wwid`**
- Flags: `protected => 1`, `proxyto => 'node'`
- Params: (`target_iqn` + `portal`) **or** `fc_wwpn`
- Returns: `{ wwid?, already_configured, existing_alias? }`
- Conflict check: scan `/etc/multipath.conf` for `wwid <value>`

**`POST /nodes/{node}/iscsi/multipath/add-device`**
- Flags: `protected => 1`, `proxyto => 'node'`
- Params: `wwid`, `alias`
- Re-checks for conflict (double safety)
- Calls existing `merge_multipath_config()` to insert block into `multipaths {}` section
- Runs `multipathd reconfigure` (non-disruptive, no daemon restart)
- Returns: null

## Frontend

### Button placement

- Sessions grid tbar (iSCSI tab): passes `target_iqn` + `portal` from selected row
- FC Targets grid tbar (FC tab): passes `port_name` (remote WWPN) from selected row
- Both buttons: `disabled: true` initially, toggle on grid `selectionchange`

### `PVE.node.ConfigureMultipathDialog` (shared)

Constructor params: `nodename`, and either `{target_iqn, portal}` or `{fc_wwpn}`.

Lifecycle:
1. Opens showing loading spinner
2. Fires GET /iscsi/multipath/wwid
3. On error or `already_configured`: shows `Ext.Msg.alert`, dialog closes
4. On success: replaces spinner with form — WWID as read-only display text, alias textfield (focused, required)
5. Submit fires POST /iscsi/multipath/add-device
6. On success: closes dialog; if the Multipath tab status store is accessible, reloads it

## Conflict Handling

- WWID not detectable (multipathd doesn't know about the device yet): error
- WWID already in multipath.conf: error showing existing alias name
- Duplicate check occurs on both GET (for UX) and POST (for safety)

## Non-goals

- Updating/renaming an existing alias (blocked with error, not supported in this iteration)
- Handling targets with multiple LUNs presenting different WWIDs
