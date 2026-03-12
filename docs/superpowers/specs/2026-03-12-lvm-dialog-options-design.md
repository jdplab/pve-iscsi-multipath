# LVM Dialog Options — Design Spec

**Date:** 2026-03-12
**Status:** Approved

## Overview

Expand the Add LVM Storage dialog with the same options available in the built-in Proxmox LVM storage wizard: Enable, Shared, node restriction, and Allow Snapshots as Volume-Chain. Node selection controls both the `pvesm add lvm --nodes` flag and which nodes receive the `lvm-scan` fire-and-forget call.

## UI Changes (`pve-iscsi-multipath.js`)

### New fields in `showAddLvmDialog`

Added below the existing Storage ID field, in order:

1. **Enable** (`proxmoxcheckbox`, itemId: `dlgEnable`, default: checked)
   — when unchecked, passes `--disable 1` to `pvesm add lvm`; when checked, `--disable` is omitted entirely. The `pvesm` `disable` boolean is set by presence: passing `--disable 1` disables storage; omitting the flag leaves it enabled. Passing `--disable 0` is equivalent to omitting it but is unnecessarily explicit — so we omit.

2. **Shared** (`proxmoxcheckbox`, itemId: `dlgShared`, default: checked)
   — maps to `--shared 1` (checked) or `--shared 0` (unchecked)
   — `change` listener: when unchecked, disables and **clears** the Nodes field; when re-checked, re-enables it

3. **Nodes** (`pveNodeSelector`, itemId: `dlgNodes`, multiSelect: true, default: empty = All)
   — disabled (and cleared) when Shared is unchecked
   — `emptyText: gettext('All') + ' (' + gettext('No restrictions') + ')'`
   — `getValue()` returns a comma-separated string (e.g. `'cclabhost22,cclabhost23'`) or empty string
   — `autoSelect: false`
   — The primary node (the one running lvm-setup) is intentionally selectable here; including it in `--nodes` is correct — it means the storage is configured on that node. It is excluded only from the lvm-scan loop (since lvm-setup already ran there).

4. **Allow Snapshots as Volume-Chain** (`proxmoxcheckbox`, itemId: `dlgSnapshotChain`, default: checked)
   — handler always sends explicit `1` or `0`; backend pushes `--snapshot-as-volume-chain 1` when truthy, omits the flag when `0`

### Shared checkbox change listener

```javascript
listeners: {
    change: function(cb, val) {
        var nodesField = dlg.down('#dlgNodes');
        if (!val) {
            nodesField.setValue('');
            nodesField.disable();
        } else {
            nodesField.enable();
        }
    }
}
```

### Updated handler — capture values before async call

```javascript
handler: function() {
    var vgName    = dlg.down('#dlgVgName').getValue().trim();
    var storageId = dlg.down('#dlgStorageId').getValue().trim();
    var nodesVal  = dlg.down('#dlgNodes').getValue();   // '' when All or Shared unchecked
    var params    = {
        device:    alias,
        vg_name:   vgName,
        storage_id: storageId,
        enable:    dlg.down('#dlgEnable').getValue() ? 1 : 0,
        shared:    dlg.down('#dlgShared').getValue() ? 1 : 0,
        snapshot_as_volume_chain: dlg.down('#dlgSnapshotChain').getValue() ? 1 : 0,
    };
    if (nodesVal) { params.nodes = nodesVal; }  // omit key when empty

    if (!vgName || !storageId) return;
    dlg.setLoading(gettext('Creating LVM storage\u2026'));
    Proxmox.Utils.API2Request({
        url: '/nodes/' + nodename + '/iscsi/lvm-setup',
        method: 'POST',
        params: params,
        success: function(r) {
            dlg.setLoading(false);
            // ... existing warnings display ...
            // Note: dlg.close() happens before lvm-scan. The info dialog (warns.length)
            // is shown before close — this matches existing behavior where the dialog
            // closes while the info box is still open. Accepted as-is.
            dlg.close();

            // lvm-scan: skip entirely if not shared; lvm-scan node param comes
            // from the URL (/nodes/{node}/iscsi/lvm-scan), no body params required
            if (!params.shared) return;

            if (nodesVal) {
                // Scan only selected nodes, excluding the primary
                nodesVal.split(',')
                    .filter(function(n) { return n !== nodename; })
                    .forEach(function(n) {
                        Proxmox.Utils.API2Request({
                            url: '/nodes/' + n + '/iscsi/lvm-scan',
                            method: 'POST',
                        });
                    });
            } else {
                // All nodes — fetch cluster status and scan all non-primary nodes
                Proxmox.Utils.API2Request({
                    url: '/cluster/status',
                    method: 'GET',
                    success: function(cr) {
                        (cr.result.data || [])
                            .filter(function(n) { return n.type === 'node' && n.name !== nodename; })
                            .forEach(function(n) {
                                Proxmox.Utils.API2Request({
                                    url: '/nodes/' + n.name + '/iscsi/lvm-scan',
                                    method: 'POST',
                                });
                            });
                    },
                });
            }
        },
        failure: function(r) {
            dlg.setLoading(false);
            Ext.Msg.alert(gettext('Error'), r.htmlStatus);
        },
    });
}
```

## Backend Changes (`ISCSIMultipath.pm`)

### `lvm-setup` new optional parameters

| Param | Type | Schema default | Notes |
|---|---|---|---|
| `enable` | boolean | none (optional) | Perl fallback: `// 1` |
| `shared` | boolean | none (optional) | Perl fallback: `// 1` |
| `nodes` | string | none (optional) | pattern: `^[a-zA-Z0-9-]+(,[a-zA-Z0-9-]+)*$`; Proxmox node names are lowercase alphanum+hyphen only |
| `snapshot_as_volume_chain` | boolean | none (optional) | Perl fallback: `// 1`; UI always sends explicit 0 or 1 |

All four are `optional => 1` in the PVE parameter schema with no `default` key. Perl-side `// 1` fallbacks are for direct API calls; the UI always sends explicit values.

### `pvesm add lvm` call

```perl
my @pvesm_cmd = (
    'pvesm', 'add', 'lvm', $storage_id,
    '--vgname',     $vg_name,
    '--shared',     ($param->{shared}  // 1) ? 1 : 0,
    '--content',    'images,rootdir',
    '--saferemove', '0',
);
push @pvesm_cmd, '--snapshot-as-volume-chain', '1'
    if $param->{snapshot_as_volume_chain} // 1;
push @pvesm_cmd, '--disable', '1'
    unless $param->{enable} // 1;
push @pvesm_cmd, '--nodes', $param->{nodes}
    if $param->{nodes};
```

### Idempotency behavior (unchanged, known limitation)

If the storage ID already exists, `pvesm add` returns `already defined` and the backend sets `storage_existed=1`, skipping registration silently. The new params are ignored on re-run. This is an accepted limitation — to change options on an existing storage, use the standard Proxmox storage management UI.

## Tests (`t/06-lvm-setup.t`)

New dedicated test file. Tests mock `_run_cmd` to capture `pvesm add` arguments and verify:

- `--snapshot-as-volume-chain 1` present when `snapshot_as_volume_chain=1` (default)
- `--snapshot-as-volume-chain` absent when `snapshot_as_volume_chain=0`
- `--disable 1` present when `enable=0`
- `--disable` absent when `enable=1` (default)
- `--nodes cclabhost22` present when `nodes='cclabhost22'`
- `--nodes` absent when `nodes` param is absent
- `--shared 0` present when `shared=0`
- `--shared 1` present by default

## Out of Scope

- Content type selector (always `images,rootdir`)
- saferemove option (always 0 for SAN-backed LVM)
- Updating an already-registered storage's options (use Proxmox storage UI)
