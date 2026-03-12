# LVM Dialog Options Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Enable, Shared, Nodes, and Allow Snapshots as Volume-Chain options to the Add LVM Storage dialog, wiring them through to the backend `lvm-setup` endpoint.

**Architecture:** Backend gains four new optional params on the `lvm-setup` endpoint; the `pvesm add lvm` command is assembled by a new extractable helper `_build_pvesm_cmd` so it can be unit-tested directly. The JS dialog gains four new fields; the lvm-scan fire-and-forget is scoped to selected nodes. A new test file `t/06-lvm-setup.t` calls `_build_pvesm_cmd` directly to verify param wiring.

**Tech Stack:** Perl (PVE API), ExtJS (Proxmox UI framework), Test::More

**Spec:** `docs/superpowers/specs/2026-03-12-lvm-dialog-options-design.md`

---

## Chunk 1: Backend — extract helper, add params, update call

### Task 1: Extract `_build_pvesm_cmd` helper and add new params to schema

**Files:**
- Modify: `src/perl/PVE/API2/ISCSIMultipath.pm`

- [ ] **Step 1: Add the `_build_pvesm_cmd` helper function**

Add this function near the other private helpers (around line 230, after `check_service_enabled`):

```perl
# Build the pvesm add lvm command array from storage_id, vg_name, and optional params.
# Extracted for testability.
sub _build_pvesm_cmd {
    my ($storage_id, $vg_name, $param) = @_;
    my @cmd = (
        'pvesm', 'add', 'lvm', $storage_id,
        '--vgname',     $vg_name,
        '--shared',     ($param->{shared} // 1) ? 1 : 0,
        '--content',    'images,rootdir',
        '--saferemove', '0',
    );
    push @cmd, '--snapshot-as-volume-chain', '1'
        if $param->{snapshot_as_volume_chain} // 1;
    push @cmd, '--disable', '1'
        unless $param->{enable} // 1;
    push @cmd, '--nodes', $param->{nodes}
        if $param->{nodes};
    return \@cmd;
}
```

- [ ] **Step 2: Add four optional params to the `lvm_setup` schema**

In the `parameters => { properties => { ... } }` block of `lvm_setup` (line ~817), add after `storage_id`:

```perl
enable   => {
    type        => 'boolean',
    optional    => 1,
    description => 'Enable storage after creation (default 1).',
},
shared   => {
    type        => 'boolean',
    optional    => 1,
    description => 'Mark storage as shared across cluster nodes (default 1).',
},
nodes    => {
    type        => 'string',
    optional    => 1,
    description => 'Comma-separated list of nodes that can use this storage. Empty means all nodes.',
    pattern     => '^[a-zA-Z0-9-]+(,[a-zA-Z0-9-]+)*$',
},
snapshot_as_volume_chain => {
    type        => 'boolean',
    optional    => 1,
    description => 'Allow snapshots as volume-chain (technology preview, default 1).',
},
```

- [ ] **Step 3: Update the `pvesm add` call in `lvm_setup` to use the helper**

Find this block in the `lvm_setup` code sub:

```perl
        # Check / register Proxmox storage
        eval {
            _run_cmd(
                ['pvesm', 'add', 'lvm', $storage_id,
                 '--vgname',   $vg_name,
                 '--shared',   '1',
                 '--content',  'images,rootdir',
                 '--saferemove', '0'],
                outfunc => sub {},
                errfunc => sub { die "$_[0]\n" },
            );
        };
```

Replace with:

```perl
        # Check / register Proxmox storage
        eval {
            _run_cmd(
                _build_pvesm_cmd($storage_id, $vg_name, $param),
                outfunc => sub {},
                errfunc => sub { die "$_[0]\n" },
            );
        };
```

- [ ] **Step 4: Verify syntax**

```bash
perl -c src/perl/PVE/API2/ISCSIMultipath.pm
```

Expected: `src/perl/PVE/API2/ISCSIMultipath.pm syntax OK`

- [ ] **Step 5: Run existing tests to confirm nothing broke**

```bash
make test
```

Expected: `All tests successful. Files=5, Tests=55`

- [ ] **Step 6: Commit**

```bash
git add src/perl/PVE/API2/ISCSIMultipath.pm
git commit -m "feat: add enable/shared/nodes/snapshot params to lvm-setup endpoint"
```

---

## Chunk 2: Tests — verify backend param wiring

### Task 2: Create `t/06-lvm-setup.t`

**Files:**
- Create: `t/06-lvm-setup.t`

The test calls `PVE::API2::ISCSIMultipath::_build_pvesm_cmd` directly — the same function used by `lvm_setup` internally — so any bug in the module's command assembly is caught.

- [ ] **Step 1: Write the test file**

```perl
#!/usr/bin/perl
use strict;
use warnings;
use Test::More tests => 10;

use lib 'src/perl';
use lib 't/lib';
use PVE::API2::ISCSIMultipath;

# Helpers
sub cmd_lacks { return !grep { $_ eq $_[1] } @{$_[0]} }

sub flag_val {
    my ($cmd, $flag) = @_;
    for my $i (0..$#$cmd - 1) {
        return $cmd->[$i+1] if $cmd->[$i] eq $flag;
    }
    return undef;
}

sub build { PVE::API2::ISCSIMultipath::_build_pvesm_cmd('s', 'vg', $_[0]) }

# 1. default: snapshot-as-volume-chain 1
my $cmd = build({});
is(flag_val($cmd, '--snapshot-as-volume-chain'), '1',
    'default: --snapshot-as-volume-chain 1');

# 2. snapshot_as_volume_chain=0: flag absent
$cmd = build({ snapshot_as_volume_chain => 0 });
ok(cmd_lacks($cmd, '--snapshot-as-volume-chain'),
    'snapshot_as_volume_chain=0: flag absent');

# 3. enable=0: --disable 1
$cmd = build({ enable => 0 });
is(flag_val($cmd, '--disable'), '1',
    'enable=0: --disable 1');

# 4. enable=1 (default): --disable absent
$cmd = build({});
ok(cmd_lacks($cmd, '--disable'),
    'enable=1 default: --disable absent');

# 5. nodes provided: --nodes with correct value
$cmd = build({ nodes => 'cclabhost22' });
is(flag_val($cmd, '--nodes'), 'cclabhost22',
    'nodes=cclabhost22: --nodes value correct');

# 6. nodes absent: --nodes absent
$cmd = build({});
ok(cmd_lacks($cmd, '--nodes'),
    'nodes absent: --nodes not in command');

# 7. shared=0: --shared 0
$cmd = build({ shared => 0 });
is(flag_val($cmd, '--shared'), '0',
    'shared=0: --shared 0');

# 8. shared=1 (default): --shared 1
$cmd = build({});
is(flag_val($cmd, '--shared'), '1',
    'shared=1 default: --shared 1');

# 9. multi-node: comma-separated value passed through
$cmd = build({ nodes => 'cclabhost22,cclabhost23' });
is(flag_val($cmd, '--nodes'), 'cclabhost22,cclabhost23',
    'nodes=cclabhost22,cclabhost23: comma-separated passed through');

# 10. combined non-defaults
$cmd = build({ enable => 0, shared => 0, nodes => 'n1', snapshot_as_volume_chain => 0 });
ok(flag_val($cmd, '--disable') eq '1' &&
   flag_val($cmd, '--shared')  eq '0' &&
   flag_val($cmd, '--nodes')   eq 'n1' &&
   cmd_lacks($cmd, '--snapshot-as-volume-chain'),
   'all non-default options combined');
```

- [ ] **Step 2: Run the new test — expect failure since `_build_pvesm_cmd` doesn't exist yet**

```bash
PERL5LIB=t/lib prove -lv t/06-lvm-setup.t
```

Expected: FAIL — `Undefined subroutine &PVE::API2::ISCSIMultipath::_build_pvesm_cmd`

- [ ] **Step 3: Implement Task 1 (backend changes above), then re-run**

```bash
PERL5LIB=t/lib prove -lv t/06-lvm-setup.t
```

Expected: `ok 1 - ok 10`, all pass.

The test file declares `tests => 10` and contains exactly 10 test assertions.

- [ ] **Step 4: Update CLAUDE.md test count**

```bash
sed -i 's/55 tests/65 tests/' CLAUDE.md
```

- [ ] **Step 5: Run full suite**

```bash
make test
```

Expected: `Files=6, Tests=65, PASS`

- [ ] **Step 6: Commit**

```bash
git add t/06-lvm-setup.t CLAUDE.md
git commit -m "test: add t/06-lvm-setup.t for pvesm command param wiring"
```

---

## Chunk 3: Frontend — dialog fields and lvm-scan scoping

### Task 3: Update `showAddLvmDialog` in JS

**Files:**
- Modify: `src/js/pve-iscsi-multipath.js` — `showAddLvmDialog` function (line ~294)

- [ ] **Step 1: Add four new fields to the dialog `items` array**

After the `dlgStorageId` textfield (the last item in the `items` array), insert:

```javascript
{
    xtype: 'proxmoxcheckbox',
    fieldLabel: gettext('Enable'),
    itemId: 'dlgEnable',
    labelWidth: 100,
    checked: true,
},
{
    xtype: 'proxmoxcheckbox',
    fieldLabel: gettext('Shared'),
    itemId: 'dlgShared',
    labelWidth: 100,
    checked: true,
    listeners: {
        change: function (cb, val) {
            var nodesField = dlg.down('#dlgNodes');
            if (!val) {
                nodesField.setValue('');
                nodesField.disable();
            } else {
                nodesField.enable();
            }
        },
    },
},
{
    xtype: 'pveNodeSelector',
    fieldLabel: gettext('Nodes'),
    itemId: 'dlgNodes',
    labelWidth: 100,
    multiSelect: true,
    autoSelect: false,
    emptyText: gettext('All') + ' (' + gettext('No restrictions') + ')',
},
{
    xtype: 'proxmoxcheckbox',
    fieldLabel: gettext('Allow Snapshots as Volume-Chain'),
    itemId: 'dlgSnapshotChain',
    labelWidth: 100,
    checked: true,
},
```

- [ ] **Step 2: Replace the Add button handler**

Find the existing `handler: function ()` on the Add button (starts after `text: gettext('Add'),`). Replace the entire handler with:

```javascript
handler: function () {
    var vgName    = dlg.down('#dlgVgName').getValue().trim();
    var storageId = dlg.down('#dlgStorageId').getValue().trim();
    var nodesVal  = dlg.down('#dlgNodes').getValue();  // '' or 'node1,node2'
    if (!vgName || !storageId) return;

    var params = {
        device:     alias,
        vg_name:    vgName,
        storage_id: storageId,
        enable:     dlg.down('#dlgEnable').getValue() ? 1 : 0,
        shared:     dlg.down('#dlgShared').getValue() ? 1 : 0,
        snapshot_as_volume_chain: dlg.down('#dlgSnapshotChain').getValue() ? 1 : 0,
    };
    if (nodesVal) { params.nodes = nodesVal; }

    dlg.setLoading(gettext('Creating LVM storage\u2026'));
    Proxmox.Utils.API2Request({
        url: '/nodes/' + nodename + '/iscsi/lvm-setup',
        method: 'POST',
        params: params,
        success: function (r) {
            dlg.setLoading(false);
            var d = r.result.data;
            var warns = [];
            if (d.pv_existed)      warns.push(gettext('PV already existed — skipped pvcreate'));
            if (d.vg_existed)      warns.push(gettext('VG already existed — skipped vgcreate'));
            if (d.storage_existed) warns.push(gettext('Storage already registered — skipped'));
            if (warns.length) {
                Ext.Msg.show({
                    title:   gettext('Add LVM Storage'),
                    icon:    Ext.Msg.INFO,
                    message: warns.join('<br>'),
                    buttons: Ext.Msg.OK,
                });
            }
            dlg.close();

            // lvm-scan: skip entirely if not shared
            if (!params.shared) return;

            if (nodesVal) {
                // Scan only selected nodes, excluding the primary
                nodesVal.split(',')
                    .filter(function (n) { return n !== nodename; })
                    .forEach(function (n) {
                        Proxmox.Utils.API2Request({
                            url: '/nodes/' + n + '/iscsi/lvm-scan',
                            method: 'POST',
                        });
                    });
            } else {
                // All nodes: fetch cluster status and scan all non-primary nodes
                Proxmox.Utils.API2Request({
                    url: '/cluster/status',
                    method: 'GET',
                    success: function (cr) {
                        (cr.result.data || [])
                            .filter(function (n) { return n.type === 'node' && n.name !== nodename; })
                            .forEach(function (n) {
                                Proxmox.Utils.API2Request({
                                    url: '/nodes/' + n.name + '/iscsi/lvm-scan',
                                    method: 'POST',
                                });
                            });
                    },
                });
            }
        },
        failure: function (r) {
            dlg.setLoading(false);
            Ext.Msg.alert(gettext('Error'), r.htmlStatus);
        },
    });
},
```

- [ ] **Step 3: Run the test suite**

```bash
make test
```

Expected: `Files=6, Tests=65, PASS`

- [ ] **Step 4: Commit**

```bash
git add src/js/pve-iscsi-multipath.js
git commit -m "feat: add enable/shared/nodes/snapshot-chain options to LVM dialog"
```

### Task 4: Build, deploy, and smoke test

- [ ] **Step 1: Build the package**

```bash
make deb
```

Expected: `pve-iscsi-multipath_0.2.0_all.deb` produced with no errors.

- [ ] **Step 2: Deploy to all three nodes**

```bash
for h in 192.168.121.21 192.168.121.22 192.168.121.23; do
  scp pve-iscsi-multipath_0.2.0_all.deb root@$h:/tmp/
  ssh root@$h 'dpkg -i /tmp/pve-iscsi-multipath_0.2.0_all.deb 2>&1 | tail -3'
done
```

Expected: `Nodes.pm patched. index.html.tpl patched.` on each node.

- [ ] **Step 3: Smoke test in browser**

Hard-refresh (`Ctrl+Shift+R`), navigate to a node → iSCSI tab → click "Add LVM Storage" on a multipath device. Verify:
- Four new fields appear: Enable (checked), Shared (checked), Nodes (empty/All), Allow Snapshots as Volume-Chain (checked)
- Unchecking Shared grays out and clears the Nodes field
- Re-checking Shared re-enables the Nodes field
- The pveNodeSelector shows cluster nodes when expanded

- [ ] **Step 4: Push dev branch**

```bash
git push origin dev
```
