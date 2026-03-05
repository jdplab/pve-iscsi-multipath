# LVM Storage Setup in GUI — Design

**Date:** 2026-03-05  
**Status:** Approved

## Goal

Add PV/VG creation and Proxmox LVM storage registration to the GUI so that the full iSCSI→multipath→LVM→storage workflow can be completed without touching the CLI.

## Scope

- New backend endpoints: `POST /iscsi/lvm-setup` and `POST /iscsi/lvm-scan`
- New wizard step in SAN Setup Wizard (between Multipath Config and Services)
- New "Add LVM Storage" button on the node iSCSI panel (alongside Configure Multipath)
- Wizard handles **one target at a time** (WWID/LVM pair) — no multi-target LVM grid

## Constraints

- One WWID → one PV → one VG → one Proxmox LVM storage (strict 1:1)
- PV/VG creation runs on **one primary node** only
- Other nodes run `vgscan`+`pvscan` to discover the new VG
- Storage registration (`POST /storage`) is cluster-wide automatically (shared storage.cfg)
- If PV or VG already exists: show a warning with clear explanation, do not fail

## Backend

### `POST /nodes/{node}/iscsi/lvm-setup`

- `protected => 1`, `proxyto => 'node'`, `Sys.Modify` permission
- Parameters: `device` (mapper device name, e.g. `proxmox-matt`), `vg_name`, `storage_id`
- Steps:
  1. Check `/dev/mapper/{device}` exists — error if not
  2. `pvdisplay /dev/mapper/{device}` — if PV exists, set `pv_existed = 1`
  3. If no PV: run `pvcreate /dev/mapper/{device}`
  4. `vgdisplay {vg_name}` — if VG exists, set `vg_existed = 1`
  5. If no VG: run `vgcreate {vg_name} /dev/mapper/{device}`
  6. Register storage via Proxmox API (type=lvm, shared=1, content=images+rootdir) — if already exists, set `storage_existed = 1`
  7. Return `{ pv_existed, vg_existed, storage_existed }` — all 0 on clean run

### `POST /nodes/{node}/iscsi/lvm-scan`

- `protected => 1`, `proxyto => 'node'`, `Sys.Modify` permission
- Runs `pvscan` and `vgscan` to discover VGs created on other nodes
- Returns null

## Wizard UI — New Step 5: "LVM Storage"

Inserted between step 4 (Multipath Config) and old step 5 (Services, becomes step 6).

**Form fields:**
- **Skip LVM setup** checkbox — disables rest of form when checked
- **Primary Node** — combobox from checked nodes, defaults to local node
- **Device** — read-only, `/dev/mapper/{alias}` derived from step 4's alias
- **VG Name** — editable text field, pre-filled `{alias}-vg`
- **Storage ID** — editable text field, pre-filled `{alias}`

**Step 4→5 transition:** reads alias from wwidsGrid, auto-populates fields.
If no new WWIDs (all already configured): auto-check Skip and show a note.

**Apply phase:** after per-node setup runs:
1. `POST /nodes/{primaryNode}/iscsi/lvm-setup`
2. Show yellow warnings for any `*_existed` flags
3. `POST /nodes/{otherNode}/iscsi/lvm-scan` for each non-primary node
4. Results shown in existing log textarea

## Node Panel — "Add LVM Storage" Button

On Sessions grid toolbar, next to "Configure Multipath". Disabled until a session is selected.

**Dialog fields:**
- **Device** — read-only, derived from multipath wwid lookup
- **VG Name** — editable, pre-filled `{alias}-vg`
- **Storage ID** — editable, pre-filled `{alias}`

**On Add:**
1. `POST /nodes/{node}/iscsi/lvm-setup`
2. Show INFO warnings for any `*_existed` flags
3. Fire-and-forget `POST /nodes/{otherNode}/iscsi/lvm-scan` for other cluster nodes
4. Close on success

If WWID not configured in multipath yet: error "Configure Multipath first".

## Error Handling

| Situation | Behavior |
|---|---|
| `/dev/mapper/{x}` not found | Fatal error: "Multipath device not found — ensure multipathd is running and WWID is configured" |
| PV already exists | Warning: "PV already exists — skipped pvcreate" |
| VG name already exists | Warning: "VG {name} already exists — skipped vgcreate" |
| Storage ID already registered | Warning: "Storage '{id}' already registered — skipped" |
| pvcreate/vgcreate fails | Fatal error with stderr |
| lvm-scan fails on other node | Non-fatal warning; does not block completion |

## Testing

Manual smoke test:
1. Fresh device → lvm-setup → verify all 3 created
2. Re-run lvm-setup → verify all 3 warnings, no error
3. lvm-scan on another node → verify VG visible
4. Node panel button: session → dialog → alias pre-fill → Add → repeat shows warnings
5. Wizard LVM step: advance from multipath, verify auto-fill, apply, check log
