# Fibre Channel Support Design

**Date:** 2026-02-26
**Version bump:** 0.1.0 → 0.2.0
**Scope:** Add FC visibility and wizard integration alongside existing iSCSI/multipath support.

## Background

The plugin currently supports iSCSI discovery, session management, and multipath configuration.
Production hosts use Fibre Channel, which requires no discovery portals — targets are presented
automatically by the FC fabric through HBA drivers. Since multipath is transport-agnostic (WWIDs
are identical regardless of transport), the wizard's steps 4–6 (WWID mapping, services, apply)
need no changes. Only target-gathering (steps 2–3) and node panel visibility need FC awareness.

## Architecture

**Core principle:** treat FC targets as "already connected" targets that are auto-discovered from
sysfs rather than from iscsiadm. Everything downstream of target selection is unchanged.

No rename of the package or API path — existing installs upgrade in place via version bump.

## Perl API Changes (`ISCSIMultipath.pm`)

### New sysfs parsers

```
parse_fc_hbas()    — reads /sys/class/fc_host/host*/
parse_fc_targets() — reads /sys/class/fc_remote_ports/rport-*/
                     filtered to roles containing "FCP Target"
```

### New endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET  | `fc/hbas`    | List local HBAs: name, WWPN, speed, port_state, symbolic_name |
| GET  | `fc/targets` | List fabric-visible FC targets: remote WWPN, via HBA, port_state |
| POST | `fc/rescan`  | Write `1` to each HBA's `issue_lip` sysfs file to re-enumerate fabric |

### Extended `/status` endpoint

Adds two new fields to the existing status response:
- `fc_hba_count` — total HBAs found in sysfs
- `fc_hbas_online` — count with `port_state == Online`

Used by wizard step 1 to show FC health in the node status grid.

### sysfs paths used

```
/sys/class/fc_host/host{N}/port_name       # local WWPN
/sys/class/fc_host/host{N}/node_name       # local WWNN
/sys/class/fc_host/host{N}/port_state      # Online | Offline | Linkdown
/sys/class/fc_host/host{N}/port_type       # NPort | NLPort | ...
/sys/class/fc_host/host{N}/speed           # 8 Gbit | 16 Gbit | ...
/sys/class/fc_host/host{N}/symbolic_name   # HBA model string
/sys/class/fc_host/host{N}/issue_lip       # write 1 to rescan

/sys/class/fc_remote_ports/rport-{H}:{B}-{I}/port_name   # remote WWPN
/sys/class/fc_remote_ports/rport-{H}:{B}-{I}/node_name   # remote WWNN
/sys/class/fc_remote_ports/rport-{H}:{B}-{I}/port_state  # Online | Blocked
/sys/class/fc_remote_ports/rport-{H}:{B}-{I}/roles       # FCP Target | FCP Initiator | ...
```

Host number extracted from rport path (e.g. `rport-3:0-1` → `host3`) to associate targets with HBAs.

## JS Changes (`pve-iscsi-multipath.js`)

### New: `PVE.node.FCPanel`

Added to node Storage group alongside existing iSCSI and Multipath tabs.

Layout: hbox with two grids.

**Left — Local HBAs** (flex 1):
- Columns: HBA, WWPN, Speed, State (color-coded: Online=green, else red)
- Toolbar: Reload, Rescan Fabric

**Right — Connected FC Targets** (flex 2):
- Columns: Remote WWPN, Via HBA, State
- Populated from `GET fc/targets`
- Auto-reloads after Rescan

Injected via the existing `PVE.panel.Config` override (same pattern as iSCSI and Multipath tabs).
Requires `caps.nodes['Sys.Audit']`.

### Wizard Step 2 (Portals) — label change only

- Title: "iSCSI Portals"
- Add instructional text: "Leave empty on FC-only hosts — FC targets are detected automatically."
- No functional change.

### Wizard Step 3 (Targets) — unified scan

- "Discover" button renamed "Scan for Targets"
- On click: fires both `GET fc/targets` and (if portals entered) `POST iscsi/discover` in parallel
- FC targets appear with `already_connected: true` and Transport = "FC"
- iSCSI targets appear as before with Transport = "iSCSI"
- Grid gains a Transport column
- Existing step 3→4 login transition already skips `already_connected` targets — no change needed

### Wizard Step 1 (Node Status) — FC health in detail column

- `/status` response now includes `fc_hba_count` and `fc_hbas_online`
- Detail string extended: e.g. "Fully configured · FC: 2/2 HBAs online" or "FC: no HBAs" if none

## What Does Not Change

- Steps 4–6 of wizard (WWID/alias mapping, services, apply) — fully transport-agnostic
- Multipath panel — already protocol-agnostic
- postinst/prerm patching logic
- API path namespace (`/nodes/{node}/iscsi/...`)
- Test infrastructure (new tests added for FC parsers)

## Files Changed

| File | Type of change |
|------|---------------|
| `src/perl/PVE/API2/ISCSIMultipath.pm` | Add FC parsers + 3 endpoints + extend status |
| `src/js/pve-iscsi-multipath.js` | Add FCPanel + wizard step 2/3 changes |
| `debian/control` | Version 0.2.0 |
| `Makefile` | Version 0.2.0 |
| `t/01-parsing.t` or new `t/04-fc-parsing.t` | Tests for parse_fc_hbas, parse_fc_targets |
