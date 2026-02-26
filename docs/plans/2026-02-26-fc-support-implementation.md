# FC Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Fibre Channel HBA visibility (node panel) and unified FC+iSCSI target scanning (wizard) to the pve-iscsi-multipath plugin.

**Architecture:** Three new sysfs-reading Perl endpoints under `iscsi/fc/`; a new `PVE.node.FCPanel` JS component injected alongside iSCSI and Multipath tabs; wizard steps 2–3 extended to surface FC fabric targets alongside iSCSI targets. Steps 4–6 (WWID mapping, services, apply) are already transport-agnostic and need no changes.

**Tech Stack:** Perl 5 / PVE::RESTHandler, ExtJS 6 / PVE.window.Wizard, Linux sysfs (`/sys/class/fc_host/`, `/sys/class/fc_remote_ports/`), `prove` test framework.

---

### Task 1: FC sysfs parser functions + tests

**Files:**
- Modify: `src/perl/PVE/API2/ISCSIMultipath.pm` (insert after `parse_multipath_status`, before `merge_multipath_config`)
- Create: `t/04-fc-parsing.t`

**Step 1: Write the failing test**

Create `t/04-fc-parsing.t`:

```perl
#!/usr/bin/perl
use strict;
use warnings;
use Test::More tests => 12;
use File::Temp qw(tempdir);
use File::Path qw(make_path);

use lib 'src/perl';
use lib 't/lib';
use PVE::API2::ISCSIMultipath;

# --- parse_fc_hbas ---
my $hba_base = tempdir(CLEANUP => 1);

my $host0 = "$hba_base/host0";
make_path($host0);
for my $attr (
    [port_name    => '0x21000024ff123456'],
    [node_name    => '0x20000024ff123456'],
    [port_state   => 'Online'],
    [port_type    => 'NPort'],
    [speed        => '8 Gbit'],
    [symbolic_name => 'QLE2562 FW:v8.09.02'],
) {
    open my $fh, '>', "$host0/$attr->[0]" or die "cannot write $attr->[0]: $!";
    print $fh $attr->[1];
    close $fh;
}

my $hbas = PVE::API2::ISCSIMultipath::parse_fc_hbas($hba_base);
is(scalar @$hbas, 1,                    'parse_fc_hbas: found one HBA');
is($hbas->[0]{name},       'host0',     'parse_fc_hbas: name');
is($hbas->[0]{port_name},  '0x21000024ff123456', 'parse_fc_hbas: WWPN');
is($hbas->[0]{port_state}, 'Online',    'parse_fc_hbas: port_state');
is($hbas->[0]{speed},      '8 Gbit',   'parse_fc_hbas: speed');

# --- parse_fc_targets ---
my $rp_base = tempdir(CLEANUP => 1);

# rport-3:0-1 is an FCP Target — should be returned
my $rport1 = "$rp_base/rport-3:0-1";
make_path($rport1);
for my $attr (
    [port_name  => '0x500143802426baf4'],
    [node_name  => '0x500143802426baf5'],
    [port_state => 'Online'],
    [roles      => 'FCP Target'],
) {
    open my $fh, '>', "$rport1/$attr->[0]" or die;
    print $fh $attr->[1];
    close $fh;
}

# rport-3:0-2 is an FCP Initiator — should be filtered out
my $rport2 = "$rp_base/rport-3:0-2";
make_path($rport2);
for my $attr (
    [port_name  => '0x210000e08b123456'],
    [node_name  => '0x200000e08b123456'],
    [port_state => 'Online'],
    [roles      => 'FCP Initiator'],
) {
    open my $fh, '>', "$rport2/$attr->[0]" or die;
    print $fh $attr->[1];
    close $fh;
}

my $targets = PVE::API2::ISCSIMultipath::parse_fc_targets($rp_base);
is(scalar @$targets, 1,                         'parse_fc_targets: filters to FCP Target only');
is($targets->[0]{port_name},  '0x500143802426baf4', 'parse_fc_targets: WWPN');
is($targets->[0]{port_state}, 'Online',             'parse_fc_targets: port_state');
is($targets->[0]{hba},        'host3',              'parse_fc_targets: host extracted from rport path');

# Empty base dirs — must not die, return empty list
is(scalar @{PVE::API2::ISCSIMultipath::parse_fc_hbas(tempdir(CLEANUP=>1))},    0,
   'parse_fc_hbas: empty base returns empty list');
is(scalar @{PVE::API2::ISCSIMultipath::parse_fc_targets(tempdir(CLEANUP=>1))}, 0,
   'parse_fc_targets: empty base returns empty list');

# HBA with missing attribute files — must not die
make_path("$hba_base/host1");  # host1 has no attribute files
my $hbas2 = PVE::API2::ISCSIMultipath::parse_fc_hbas($hba_base);
is(scalar @$hbas2, 2, 'parse_fc_hbas: handles missing attribute files gracefully');
```

**Step 2: Run test to verify it fails**

```bash
PERL5LIB=t/lib prove -lv t/04-fc-parsing.t
```
Expected: compile error — `Undefined subroutine &PVE::API2::ISCSIMultipath::parse_fc_hbas`.

**Step 3: Implement the parsers**

In `src/perl/PVE/API2/ISCSIMultipath.pm`, find the line:
```
# Merge new {wwid, alias} entries into an existing multipath.conf string.
```

Insert the following block immediately before that line:

```perl
# Parse FC HBA info from sysfs.
# $base defaults to /sys/class/fc_host; pass a temp dir in tests.
sub parse_fc_hbas {
    my ($base) = @_;
    $base //= '/sys/class/fc_host';
    my @hbas;
    for my $host_path (glob "$base/host*") {
        my $name = (split m{/}, $host_path)[-1];
        my %hba = (name => $name);
        for my $attr (qw(port_name node_name port_state port_type speed symbolic_name)) {
            if (open my $fh, '<', "$host_path/$attr") {
                local $/;
                ($hba{$attr} = <$fh>) =~ s/\s+$//;
                close $fh;
            } else {
                $hba{$attr} = '';
            }
        }
        push @hbas, \%hba;
    }
    return \@hbas;
}

# Parse FC fabric targets from sysfs, filtered to FCP Target role only.
# $base defaults to /sys/class/fc_remote_ports; pass a temp dir in tests.
sub parse_fc_targets {
    my ($base) = @_;
    $base //= '/sys/class/fc_remote_ports';
    my @targets;
    for my $rport_path (glob "$base/rport-*") {
        my $roles = '';
        if (open my $fh, '<', "$rport_path/roles") {
            local $/;
            ($roles = <$fh>) =~ s/\s+$//;
            close $fh;
        }
        next unless $roles =~ /FCP Target/i;

        my %target;
        for my $attr (qw(port_name node_name port_state)) {
            if (open my $fh, '<', "$rport_path/$attr") {
                local $/;
                ($target{$attr} = <$fh>) =~ s/\s+$//;
                close $fh;
            } else {
                $target{$attr} = '';
            }
        }
        # Extract host number from rport name: rport-H:B-I → hostH
        my $rport_name = (split m{/}, $rport_path)[-1];
        my ($host_num) = ($rport_name =~ /^rport-(\d+):/);
        $target{hba} = defined $host_num ? "host$host_num" : '';
        push @targets, \%target;
    }
    return \@targets;
}

```

**Step 4: Run new tests**

```bash
PERL5LIB=t/lib prove -lv t/04-fc-parsing.t
```
Expected: All 12 tests pass.

**Step 5: Run full suite to confirm no regressions**

```bash
PERL5LIB=t/lib prove -lv t/
```
Expected: All tests pass.

**Step 6: Commit**

```bash
git add src/perl/PVE/API2/ISCSIMultipath.pm t/04-fc-parsing.t
git commit -m "feat: add parse_fc_hbas and parse_fc_targets sysfs parsers"
```

---

### Task 2: FC API endpoints

**Files:**
- Modify: `src/perl/PVE/API2/ISCSIMultipath.pm` (after `set_startup` endpoint, before `multipath_status` endpoint)

No new tests — endpoints are thin wrappers around parsers already tested in Task 1. The rescan writes directly to sysfs and is too I/O-bound to mock usefully.

**Step 1: Add the three FC endpoints**

In `ISCSIMultipath.pm`, find the line:
```perl
__PACKAGE__->register_method({
    name        => 'multipath_status',
```

Insert the following block immediately before it:

```perl
__PACKAGE__->register_method({
    name        => 'fc_hbas',
    path        => 'fc/hbas',
    method      => 'GET',
    description => 'List local Fibre Channel HBAs from sysfs.',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Audit']] },
    parameters  => {
        additionalProperties => 0,
        properties => { node => get_standard_option('pve-node') },
    },
    returns => { type => 'array', items => { type => 'object' } },
    code => sub {
        my ($param) = @_;
        return parse_fc_hbas();
    },
});

__PACKAGE__->register_method({
    name        => 'fc_targets',
    path        => 'fc/targets',
    method      => 'GET',
    description => 'List FC fabric targets visible through local HBAs.',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Audit']] },
    parameters  => {
        additionalProperties => 0,
        properties => { node => get_standard_option('pve-node') },
    },
    returns => { type => 'array', items => { type => 'object' } },
    code => sub {
        my ($param) = @_;
        return parse_fc_targets();
    },
});

__PACKAGE__->register_method({
    name        => 'fc_rescan',
    path        => 'fc/rescan',
    method      => 'POST',
    description => 'Trigger LIP (fabric re-enumeration) on all local FC HBAs.',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Modify']] },
    parameters  => {
        additionalProperties => 0,
        properties => { node => get_standard_option('pve-node') },
    },
    returns => { type => 'null' },
    code => sub {
        my ($param) = @_;
        for my $host_path (glob '/sys/class/fc_host/host*') {
            if (open my $fh, '>', "$host_path/issue_lip") {
                print $fh "1";
                close $fh;
            }
        }
        return undef;
    },
});

```

**Step 2: Run full test suite**

```bash
PERL5LIB=t/lib prove -lv t/
```
Expected: All tests pass.

**Step 3: Commit**

```bash
git add src/perl/PVE/API2/ISCSIMultipath.pm
git commit -m "feat: add FC API endpoints (fc/hbas, fc/targets, fc/rescan)"
```

---

### Task 3: Extend /status with FC HBA counts

**Files:**
- Modify: `src/perl/PVE/API2/ISCSIMultipath.pm` (the `status` endpoint's `code` sub)

**Step 1: Add FC data to status response**

In the `status` endpoint's `code` sub, find:
```perl
        return {
            packages              => \%pkgs,
            services              => \%svcs,
            sessions              => $sessions,
            multipath_config_exists => (-f '/etc/multipath.conf') ? 1 : 0,
            multipath_devices     => $mp_devices,
        };
```

Replace with:
```perl
        my $fc_hbas   = parse_fc_hbas();
        my $fc_online = scalar grep { $_->{port_state} eq 'Online' } @$fc_hbas;

        return {
            packages              => \%pkgs,
            services              => \%svcs,
            sessions              => $sessions,
            multipath_config_exists => (-f '/etc/multipath.conf') ? 1 : 0,
            multipath_devices     => $mp_devices,
            fc_hba_count          => scalar @$fc_hbas,
            fc_hbas_online        => $fc_online,
        };
```

**Step 2: Run full test suite**

```bash
PERL5LIB=t/lib prove -lv t/
```
Expected: All tests still pass (existing status tests don't check the new fields).

**Step 3: Commit**

```bash
git add src/perl/PVE/API2/ISCSIMultipath.pm
git commit -m "feat: include fc_hba_count and fc_hbas_online in /status response"
```

---

### Task 4: JS — PVE.node.FCPanel

**Files:**
- Modify: `src/js/pve-iscsi-multipath.js`
  - Insert FCPanel definition (after `PVE.node.MultipathPanel`, before `PVE.dc.ISCSISetupWizard`)
  - Add FCPanel to existing `PVE.panel.Config` override

**Step 1: Insert FCPanel definition**

Find the exact line:
```javascript
Ext.define('PVE.dc.ISCSISetupWizard', {
```

Insert the following block immediately before it:

```javascript
Ext.define('PVE.node.FCPanel', {
    extend: 'Ext.panel.Panel',
    xtype: 'pveNodeFCPanel',

    layout: {
        type: 'hbox',
        align: 'stretch',
    },

    initComponent: function () {
        var me = this;
        var nodename = me.pveSelNode.data.node;
        if (!nodename) throw 'no node name specified';

        var hbasStore = Ext.create('Ext.data.Store', {
            fields: ['name', 'port_name', 'node_name', 'port_state', 'speed', 'symbolic_name'],
            proxy: {
                type: 'proxmox',
                url: '/api2/json/nodes/' + nodename + '/iscsi/fc/hbas',
            },
        });

        var targetsStore = Ext.create('Ext.data.Store', {
            fields: ['port_name', 'node_name', 'hba', 'port_state'],
            proxy: {
                type: 'proxmox',
                url: '/api2/json/nodes/' + nodename + '/iscsi/fc/targets',
            },
        });

        var reload = function () {
            hbasStore.load();
            targetsStore.load();
        };

        var rescan = function () {
            Proxmox.Utils.API2Request({
                url: '/nodes/' + nodename + '/iscsi/fc/rescan',
                method: 'POST',
                waitMsgTarget: me,
                success: function () {
                    Ext.defer(reload, 2000);
                },
                failure: function (r) {
                    Ext.Msg.alert(gettext('Error'), r.htmlStatus);
                },
            });
        };

        var stateRenderer = function (v) {
            var color = (v === 'Online') ? '#2c9142' : '#cc2a2a';
            return '<span style="color:' + color + '">' + Ext.String.htmlEncode(v || '') + '</span>';
        };

        Ext.apply(me, {
            items: [
                {
                    xtype: 'grid',
                    title: gettext('Local HBAs'),
                    flex: 1,
                    store: hbasStore,
                    columns: [
                        { text: gettext('HBA'),   dataIndex: 'name',      width: 70 },
                        { text: 'WWPN',           dataIndex: 'port_name', flex: 2 },
                        { text: gettext('Speed'),  dataIndex: 'speed',     width: 80 },
                        { text: gettext('State'),  dataIndex: 'port_state', width: 80, renderer: stateRenderer },
                    ],
                    tbar: [
                        {
                            text: gettext('Reload'),
                            iconCls: 'fa fa-refresh',
                            handler: reload,
                        },
                        {
                            text: gettext('Rescan Fabric'),
                            iconCls: 'fa fa-search',
                            handler: rescan,
                        },
                    ],
                },
                {
                    xtype: 'grid',
                    title: gettext('Connected FC Targets'),
                    flex: 2,
                    store: targetsStore,
                    columns: [
                        { text: 'Remote WWPN',    dataIndex: 'port_name', flex: 2 },
                        { text: gettext('Via HBA'), dataIndex: 'hba',     width: 70 },
                        { text: gettext('State'),  dataIndex: 'port_state', width: 80, renderer: stateRenderer },
                    ],
                },
            ],
        });

        me.callParent();
        reload();
    },
});

```

**Step 2: Add FCPanel to the PVE.panel.Config override**

Find the existing `me.items.push(` call in the `PVE.panel.Config` override. It currently pushes two items (iSCSI and Multipath). Add the FC tab as a third item.

Find:
```javascript
                me.items.push(
                    {
                        xtype: 'pveNodeISCSIPanel',
                        title: 'iSCSI',
                        itemId: 'iscsi',
                        iconCls: 'fa fa-plug',
                        groups: ['storage'],
                        pveSelNode: me.pveSelNode,
                    },
                    {
                        xtype: 'pveNodeMultipathPanel',
                        title: 'Multipath',
                        itemId: 'multipath',
                        iconCls: 'fa fa-sitemap',
                        groups: ['storage'],
                        pveSelNode: me.pveSelNode,
                    }
                );
```

Replace with:
```javascript
                me.items.push(
                    {
                        xtype: 'pveNodeISCSIPanel',
                        title: 'iSCSI',
                        itemId: 'iscsi',
                        iconCls: 'fa fa-plug',
                        groups: ['storage'],
                        pveSelNode: me.pveSelNode,
                    },
                    {
                        xtype: 'pveNodeMultipathPanel',
                        title: 'Multipath',
                        itemId: 'multipath',
                        iconCls: 'fa fa-sitemap',
                        groups: ['storage'],
                        pveSelNode: me.pveSelNode,
                    },
                    {
                        xtype: 'pveNodeFCPanel',
                        title: 'Fibre Channel',
                        itemId: 'fc',
                        iconCls: 'fa fa-circle-o',
                        groups: ['storage'],
                        pveSelNode: me.pveSelNode,
                    }
                );
```

**Step 3: Commit**

```bash
git add src/js/pve-iscsi-multipath.js
git commit -m "feat: add PVE.node.FCPanel with HBA status and FC target list"
```

---

### Task 5: JS — Wizard unified FC+iSCSI target scan

**Files:**
- Modify: `src/js/pve-iscsi-multipath.js`

This task makes four small, precise changes.

**Step 1: Add `transport` field to targetsStore**

Find:
```javascript
        var targetsStore = Ext.create('Ext.data.Store', {
            fields: ['target_iqn', 'portal', 'selected', 'already_connected'],
            data: [],
        });
```

Replace with:
```javascript
        var targetsStore = Ext.create('Ext.data.Store', {
            fields: ['target_iqn', 'portal', 'selected', 'already_connected', 'transport'],
            data: [],
        });
```

**Step 2: Update step 2 — rename title, add hint, change layout to accommodate hint**

Find:
```javascript
                // --- Step 2 ---
                {
                    title: gettext('Portals'),
                    xtype: 'panel',
                    itemId: 'step2',
                    layout: 'fit',
                    items: [{
                        xtype: 'grid',
                        itemId: 'portalsGrid',
                        store: portalsStore,
                        columns: [{ text: gettext('Portal IP:port'), dataIndex: 'portal', flex: 1 }],
                        tbar: [
                            {
                                text: gettext('Add'),
                                iconCls: 'fa fa-plus',
                                handler: function () {
                                    Ext.Msg.prompt(gettext('Add Portal'), gettext('Portal IP:'),
                                        function (btn, val) {
                                            if (btn !== 'ok' || !val) return;
                                            var p = val.trim();
                                            if (!p.match(/:/)) p += ':3260';
                                            portalsStore.add({ portal: p });
                                        });
                                },
                            },
                            {
                                text: gettext('Remove'),
                                iconCls: 'fa fa-trash-o',
                                handler: function () {
                                    var g = me.down('#portalsGrid');
                                    var sel = g.getSelection();
                                    if (sel.length) portalsStore.remove(sel);
                                },
                            },
                        ],
                    }],
                },
```

Replace with:
```javascript
                // --- Step 2 ---
                {
                    title: gettext('iSCSI Portals'),
                    xtype: 'panel',
                    itemId: 'step2',
                    layout: { type: 'vbox', align: 'stretch' },
                    items: [
                        {
                            xtype: 'displayfield',
                            value: gettext('Leave empty on FC-only hosts \u2014 FC targets are detected automatically.'),
                            margin: '5 5 0 5',
                        },
                        {
                            xtype: 'grid',
                            itemId: 'portalsGrid',
                            flex: 1,
                            store: portalsStore,
                            columns: [{ text: gettext('Portal IP:port'), dataIndex: 'portal', flex: 1 }],
                            tbar: [
                                {
                                    text: gettext('Add'),
                                    iconCls: 'fa fa-plus',
                                    handler: function () {
                                        Ext.Msg.prompt(gettext('Add Portal'), gettext('Portal IP:'),
                                            function (btn, val) {
                                                if (btn !== 'ok' || !val) return;
                                                var p = val.trim();
                                                if (!p.match(/:/)) p += ':3260';
                                                portalsStore.add({ portal: p });
                                            });
                                    },
                                },
                                {
                                    text: gettext('Remove'),
                                    iconCls: 'fa fa-trash-o',
                                    handler: function () {
                                        var g = me.down('#portalsGrid');
                                        var sel = g.getSelection();
                                        if (sel.length) portalsStore.remove(sel);
                                    },
                                },
                            ],
                        },
                    ],
                },
```

**Step 3: Update step 3 — Transport column + unified scan button**

Find:
```javascript
                // --- Step 3 ---
                {
                    title: gettext('Select Targets'),
                    xtype: 'panel',
                    itemId: 'step3',
                    layout: 'fit',
                    items: [{
                        xtype: 'grid',
                        store: targetsStore,
                        columns: [
                            { xtype: 'checkcolumn', dataIndex: 'selected', header: '', width: 40 },
                            { text: gettext('Target IQN'), dataIndex: 'target_iqn', flex: 2 },
                            { text: gettext('Portal'),     dataIndex: 'portal',     flex: 1 },
                            { text: gettext('Status'),     dataIndex: 'already_connected',
                              renderer: function (v) { return v ? gettext('already connected') : ''; } },
                        ],
                    }],
                    tbar: [{
                        text: gettext('Discover'),
                        iconCls: 'fa fa-search',
                        handler: function () {
                            var firstNode = null;
                            nodeStatusStore.each(function (r) {
                                if (r.get('checked') && !firstNode) firstNode = r.get('node');
                            });
                            if (!firstNode) {
                                Ext.Msg.alert(gettext('Error'), gettext('Select at least one node.'));
                                return;
                            }
                            var portals = portalsStore.collect('portal').join(',');
                            Proxmox.Utils.API2Request({
                                url: '/api2/json/nodes/' + firstNode + '/iscsi/discover',
                                method: 'POST',
                                params: { portals: portals },
                                waitMsgTarget: me,
                                success: function (response) {
                                    var targets = response.result.data;
                                    var statusRec = nodeStatusStore.findRecord('node', firstNode);
                                    var sessions = (statusRec && statusRec.get('_statusData'))
                                        ? statusRec.get('_statusData').sessions : [];
                                    var connectedIqns = sessions.map(s => s.target_iqn);

                                    // Deduplicate by IQN
                                    var seen = {};
                                    var unique = targets.filter(function (t) {
                                        if (seen[t.target_iqn]) return false;
                                        seen[t.target_iqn] = true;
                                        return true;
                                    });
                                    targetsStore.loadData(unique.map(t => ({
                                        target_iqn: t.target_iqn,
                                        portal: t.portal,
                                        selected: true,
                                        already_connected: connectedIqns.includes(t.target_iqn),
                                    })));
                                },
                                failure: function (r) {
                                    Ext.Msg.alert(gettext('Error'), r.htmlStatus);
                                },
                            });
                        },
                    }],
                },
```

Replace with:
```javascript
                // --- Step 3 ---
                {
                    title: gettext('Select Targets'),
                    xtype: 'panel',
                    itemId: 'step3',
                    layout: 'fit',
                    items: [{
                        xtype: 'grid',
                        store: targetsStore,
                        columns: [
                            { xtype: 'checkcolumn', dataIndex: 'selected', header: '', width: 40 },
                            { text: gettext('Target'),    dataIndex: 'target_iqn', flex: 2 },
                            { text: gettext('Transport'), dataIndex: 'transport',  width: 70 },
                            { text: gettext('Portal'),    dataIndex: 'portal',     flex: 1 },
                            { text: gettext('Status'),    dataIndex: 'already_connected',
                              renderer: function (v) { return v ? gettext('already connected') : ''; } },
                        ],
                    }],
                    tbar: [{
                        text: gettext('Scan for Targets'),
                        iconCls: 'fa fa-search',
                        handler: function () {
                            var firstNode = null;
                            nodeStatusStore.each(function (r) {
                                if (r.get('checked') && !firstNode) firstNode = r.get('node');
                            });
                            if (!firstNode) {
                                Ext.Msg.alert(gettext('Error'), gettext('Select at least one node.'));
                                return;
                            }

                            targetsStore.removeAll();
                            var seen = {};
                            var addTargets = function (items) {
                                items.forEach(function (t) {
                                    if (!seen[t.target_iqn]) {
                                        seen[t.target_iqn] = true;
                                        targetsStore.add(t);
                                    }
                                });
                            };

                            // FC targets — always attempt; returns empty list if no HBAs
                            Proxmox.Utils.API2Request({
                                url: '/api2/json/nodes/' + firstNode + '/iscsi/fc/targets',
                                method: 'GET',
                                success: function (response) {
                                    addTargets((response.result.data || []).map(function (t) {
                                        return {
                                            target_iqn:        t.port_name,
                                            portal:            '',
                                            transport:         'FC',
                                            selected:          true,
                                            already_connected: true,
                                        };
                                    }));
                                },
                            });

                            // iSCSI targets — only if portals were entered
                            var portals = portalsStore.collect('portal');
                            if (portals.length > 0) {
                                var statusRec = nodeStatusStore.findRecord('node', firstNode);
                                var sessions = (statusRec && statusRec.get('_statusData'))
                                    ? statusRec.get('_statusData').sessions : [];
                                var connectedIqns = sessions.map(function (s) { return s.target_iqn; });

                                Proxmox.Utils.API2Request({
                                    url: '/api2/json/nodes/' + firstNode + '/iscsi/discover',
                                    method: 'POST',
                                    params: { portals: portals.join(',') },
                                    waitMsgTarget: me,
                                    success: function (response) {
                                        var seenIqn = {};
                                        addTargets((response.result.data || [])
                                            .filter(function (t) {
                                                if (seenIqn[t.target_iqn]) return false;
                                                seenIqn[t.target_iqn] = true;
                                                return true;
                                            })
                                            .map(function (t) {
                                                return {
                                                    target_iqn:        t.target_iqn,
                                                    portal:            t.portal,
                                                    transport:         'iSCSI',
                                                    selected:          true,
                                                    already_connected: connectedIqns.includes(t.target_iqn),
                                                };
                                            }));
                                    },
                                    failure: function (r) {
                                        Ext.Msg.alert(gettext('Error'), r.htmlStatus);
                                    },
                                });
                            }
                        },
                    }],
                },
```

**Step 4: Filter FC targets out of iSCSI setup call in startApply**

Find in the `startApply` function:
```javascript
            var targets = [];
            targetsStore.each(function (r) { if (r.get('selected')) targets.push(r.get('target_iqn')); });
```

Replace with:
```javascript
            var targets = [];
            targetsStore.each(function (r) {
                if (r.get('selected') && r.get('transport') !== 'FC') {
                    targets.push(r.get('target_iqn'));
                }
            });
```

**Step 5: Add FC status to wizard node status detail string**

In the `checkNodeStatus` callback, find where `detail` strings are assigned (inside the success handler of `GET /iscsi/status`). After the existing `status`/`detail` assignments, add an FC suffix.

Find:
```javascript
                        var status, detail;
                        if (!pkgsOk) {
                            status = 'orange';
                            detail = gettext('Packages missing');
                        } else if (svcsOk && hasSessions && hasConfig) {
                            status = 'green';
                            detail = gettext('Fully configured');
                        } else if (hasSessions || hasConfig) {
                            status = 'yellow';
                            detail = gettext('Partial') + ' (' + d.sessions.length +
                                     ' sessions, config=' + (hasConfig ? 'yes' : 'no') + ')';
                        } else {
                            status = 'red';
                            detail = gettext('Not configured');
                        }
                        rec.set('status', status);
                        rec.set('detail', detail);
```

Replace with:
```javascript
                        var status, detail;
                        if (!pkgsOk) {
                            status = 'orange';
                            detail = gettext('Packages missing');
                        } else if (svcsOk && hasSessions && hasConfig) {
                            status = 'green';
                            detail = gettext('Fully configured');
                        } else if (hasSessions || hasConfig) {
                            status = 'yellow';
                            detail = gettext('Partial') + ' (' + d.sessions.length +
                                     ' sessions, config=' + (hasConfig ? 'yes' : 'no') + ')';
                        } else {
                            status = 'red';
                            detail = gettext('Not configured');
                        }
                        if (d.fc_hba_count > 0) {
                            detail += ' \u00b7 FC: ' + d.fc_hbas_online + '/' + d.fc_hba_count + ' HBAs online';
                        }
                        rec.set('status', status);
                        rec.set('detail', detail);
```

**Step 6: Commit**

```bash
git add src/js/pve-iscsi-multipath.js
git commit -m "feat: unified FC+iSCSI target scan in wizard, FC transport column"
```

---

### Task 6: Version bump

**Files:**
- Modify: `Makefile` (line 2)

**Step 1: Update version**

Find:
```makefile
VERSION=0.1.0
```

Replace with:
```makefile
VERSION=0.2.0
```

**Step 2: Commit**

```bash
git add Makefile
git commit -m "chore: bump version to 0.2.0"
```

---

### Task 7: Build deb and deploy

**Step 1: Build**

```bash
cd /home/jpolansky/proxmox-storage-plugin
make deb
```
Expected: `pve-iscsi-multipath_0.2.0_all.deb` created, no errors.

**Step 2: Copy to host and install**

```bash
scp pve-iscsi-multipath_0.2.0_all.deb root@cclabhost23:/tmp/
ssh root@cclabhost23 "dpkg -i /tmp/pve-iscsi-multipath_0.2.0_all.deb"
```

**Step 3: Verify GUI on iSCSI dev host (cclabhost23)**

1. Hard-refresh browser (`Ctrl+Shift+R`)
2. Navigate to a node → Storage group in the left nav
3. Confirm three tabs appear: iSCSI, Multipath, Fibre Channel
4. Fibre Channel tab loads without JS errors; HBA grid is empty (no FC HBAs on dev host — expected)
5. Datacenter → Storage → SAN Setup wizard opens
6. Step 2 title reads "iSCSI Portals" and hint text is visible
7. Step 3 "Scan for Targets" button works; Transport column is present in grid

**Step 4: Verify on FC prod host (when accessible)**

1. Fibre Channel tab shows HBA WWPNs with link state
2. Connected FC Targets grid shows remote port WWPNs
3. Rescan Fabric button triggers without error; grid reloads after ~2 seconds
4. Wizard step 3 Scan populates FC targets (Transport=FC, already connected) without any portals entered
