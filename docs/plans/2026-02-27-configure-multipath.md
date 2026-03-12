# Configure Multipath Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a "Configure Multipath" button to the iSCSI Sessions and FC Targets grids that auto-detects the WWID for a selected target and adds a named block to `/etc/multipath.conf`.

**Architecture:** Two new backend endpoints (`GET multipath/wwid` for discovery, `POST multipath/add-device` for writing) backed by three pure helper subs that can be unit-tested in isolation. The frontend adds a disabled button to each grid that enables on row selection and opens a shared dialog.

**Tech Stack:** Perl (PVE::RESTHandler, iscsiadm, multipath, sysfs), ExtJS 6 (Proxmox VE GUI patterns)

---

### Task 1: Backend helpers — `_build_host_wwid_map` and `_parse_session_host`

**Files:**
- Modify: `src/perl/PVE/API2/ISCSIMultipath.pm` (after the `merge_multipath_config` sub, before `_run_cmd`)
- Create: `t/05-wwid-discovery.t`

**Step 1: Write the failing tests**

Create `t/05-wwid-discovery.t`:

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

# Sample multipath -ll output (two devices, three paths total)
my $mp_output = <<'END';
proxmox-bruce (36589cfc000AAA) dm-1 IET,VIRTUAL-DISK
size=100G features='0' hwhandler='0' wp=rw
`-+- policy='round-robin 0' prio=1 status=active
  |- 3:0:0:0 sdb 8:16 active ready running
  `- 4:0:0:0 sdd 8:48 active ready running
proxmox-mgmt (36589cfc000BBB) dm-2 IET,VIRTUAL-DISK
size=50G features='0' hwhandler='0' wp=rw
`-+- policy='round-robin 0' prio=1 status=active
  `- 5:0:0:0 sdc 8:32 active ready running
END

# --- _build_host_wwid_map ---
my $map = PVE::API2::ISCSIMultipath::_build_host_wwid_map($mp_output);
is($map->{3}, '36589cfc000AAA', '_build_host_wwid_map: host 3 → first WWID');
is($map->{4}, '36589cfc000AAA', '_build_host_wwid_map: host 4 → same WWID (multipath)');
is($map->{5}, '36589cfc000BBB', '_build_host_wwid_map: host 5 → second WWID');
ok(!defined $map->{9},           '_build_host_wwid_map: unknown host → undef');

# Device without alias (wwid is first token, no parentheses)
my $mp_no_alias = <<'END';
36589cfc000CCC dm-3 IET,VIRTUAL-DISK
size=10G features='0' hwhandler='0' wp=rw
`- 7:0:0:0 sde 8:64 active ready running
END
my $map2 = PVE::API2::ISCSIMultipath::_build_host_wwid_map($mp_no_alias);
is($map2->{7}, '36589cfc000CCC', '_build_host_wwid_map: unaliased device');

# --- _parse_session_host ---
my $session_p3 = <<'END';
iSCSI Transport Class version 2.0-870
version 2.1.9
Target: iqn.2005-10.org.freenas.ctl:proxmox-bruce
	Current Portal: 192.168.122.15:3260,1
	Persistent Portal: 192.168.122.15:3260,1
		************************
		Attached SCSI devices:
		************************
		Host Number: 3	State: running
		scsi3 Channel 00 Id 0 Lun: 0
			Attached scsi disk sdb		State: running
Target: iqn.2005-10.org.freenas.ctl:proxmox-mgmt
	Current Portal: 192.168.122.15:3260,1
	Persistent Portal: 192.168.122.15:3260,1
		************************
		Attached SCSI devices:
		************************
		Host Number: 5	State: running
		scsi5 Channel 00 Id 0 Lun: 0
			Attached scsi disk sdc		State: running
END

is(PVE::API2::ISCSIMultipath::_parse_session_host(
       $session_p3,
       'iqn.2005-10.org.freenas.ctl:proxmox-bruce',
       '192.168.122.15:3260'),
   3, '_parse_session_host: finds host 3 for first target');

is(PVE::API2::ISCSIMultipath::_parse_session_host(
       $session_p3,
       'iqn.2005-10.org.freenas.ctl:proxmox-mgmt',
       '192.168.122.15:3260'),
   5, '_parse_session_host: finds host 5 for second target');

ok(!defined PVE::API2::ISCSIMultipath::_parse_session_host(
       $session_p3,
       'iqn.2005-10.org.freenas.ctl:nonexistent',
       '192.168.122.15:3260'),
   '_parse_session_host: unknown target → undef');

# Portal with ,tpgt suffix in iscsiadm output is stripped correctly
is(PVE::API2::ISCSIMultipath::_parse_session_host(
       $session_p3,
       'iqn.2005-10.org.freenas.ctl:proxmox-bruce',
       '192.168.122.15:3260'),
   3, '_parse_session_host: strips ,tpgt from portal in output');
```

**Step 2: Run to confirm failures**

```bash
cd /home/jpolansky/proxmox-storage-plugin
prove -lv t/05-wwid-discovery.t 2>&1 | head -30
```

Expected: compilation failure (functions not defined yet).

**Step 3: Add the two helper subs to ISCSIMultipath.pm**

Add these two subs after the `merge_multipath_config` sub (after line ~141) and before the `_run_cmd` sub:

```perl
# Build a map of { host_num => wwid } from `multipath -ll` text output.
# Handles both aliased ("alias (wwid) dm-N") and unaliased ("wwid dm-N") lines.
sub _build_host_wwid_map {
    my ($mp_output) = @_;
    my %map;
    my $current_wwid;
    for my $line (split /\n/, $mp_output) {
        if ($line =~ /\(([^)]+)\)\s+dm-\d+/) {
            $current_wwid = $1;                    # aliased: alias (wwid) dm-N
        } elsif ($line =~ /^([^\s(]+)\s+dm-\d+/) {
            $current_wwid = $1;                    # unaliased: wwid dm-N
        }
        if ($current_wwid && $line =~ /[|`\s]-\s+(\d+):\d+:\d+:\d+/) {
            $map{$1} = $current_wwid;
        }
    }
    return \%map;
}

# Parse `iscsiadm -m session -P 3` text to find the SCSI host number for a
# given target_iqn + portal pair.  Returns undef if not found.
sub _parse_session_host {
    my ($session_p3_output, $target_iqn, $portal) = @_;
    $portal =~ s/,\d+$//;                          # strip ,tpgt if present
    $portal .= ':3260' unless $portal =~ /:\d+$/;  # default port

    my ($in_target, $portal_ok);
    for my $line (split /\n/, $session_p3_output) {
        if ($line =~ /^\s*Target:\s+(\S+)/) {
            $in_target  = ($1 eq $target_iqn);
            $portal_ok  = 0;
        }
        next unless $in_target;
        if ($line =~ /Current Portal:\s+(\S+?)(?:,\d+)?\s*$/) {
            my $p = $1;
            $p .= ':3260' unless $p =~ /:\d+$/;
            $portal_ok = ($p eq $portal);
        }
        if ($portal_ok && $line =~ /Host Number:\s+(\d+)/) {
            return $1 + 0;
        }
    }
    return undef;
}
```

**Step 4: Run tests again**

```bash
prove -lv t/05-wwid-discovery.t
```

Expected: all tests for `_build_host_wwid_map` and `_parse_session_host` pass.

**Step 5: Commit**

```bash
git add src/perl/PVE/API2/ISCSIMultipath.pm t/05-wwid-discovery.t
git commit -m "feat: add _build_host_wwid_map and _parse_session_host helpers"
```

---

### Task 2: Backend helper — `_fc_host_for_wwpn`

**Files:**
- Modify: `src/perl/PVE/API2/ISCSIMultipath.pm` (add sub after `_parse_session_host`)
- Modify: `t/05-wwid-discovery.t` (add tests, update test count)

**Step 1: Add the remaining tests to `t/05-wwid-discovery.t`**

Update the test count to `tests => 16` at the top, then append:

```perl
# --- _fc_host_for_wwpn ---
my $rp_base = tempdir(CLEANUP => 1);

# rport-3:0-1 has the target WWPN we're looking for
my $rport1 = "$rp_base/rport-3:0-1";
make_path($rport1);
open my $fh1, '>', "$rport1/port_name" or die;
print $fh1 '0x500143802426baf4';
close $fh1;

# rport-7:0-2 has a different WWPN
my $rport2 = "$rp_base/rport-7:0-2";
make_path($rport2);
open my $fh2, '>', "$rport2/port_name" or die;
print $fh2 '0x500143802426bbbb';
close $fh2;

is(PVE::API2::ISCSIMultipath::_fc_host_for_wwpn('0x500143802426baf4', $rp_base),
   3, '_fc_host_for_wwpn: finds host 3 from rport-3:0-1');

is(PVE::API2::ISCSIMultipath::_fc_host_for_wwpn('0x500143802426bbbb', $rp_base),
   7, '_fc_host_for_wwpn: finds host 7 from rport-7:0-2');

ok(!defined PVE::API2::ISCSIMultipath::_fc_host_for_wwpn('0xdeadbeef', $rp_base),
   '_fc_host_for_wwpn: unknown WWPN → undef');

ok(!defined PVE::API2::ISCSIMultipath::_fc_host_for_wwpn(
       '0x500143802426baf4', tempdir(CLEANUP => 1)),
   '_fc_host_for_wwpn: empty rports dir → undef');
```

**Step 2: Run to confirm the new tests fail**

```bash
prove -lv t/05-wwid-discovery.t 2>&1 | tail -20
```

Expected: new 4 tests fail, existing 12 still pass.

**Step 3: Add `_fc_host_for_wwpn` to ISCSIMultipath.pm** (after `_parse_session_host`):

```perl
# Find the local SCSI host number for a given remote FC target WWPN by reading
# /sys/class/fc_remote_ports.  $rports_base can be overridden for testing.
sub _fc_host_for_wwpn {
    my ($wwpn, $rports_base) = @_;
    $rports_base //= '/sys/class/fc_remote_ports';
    for my $rport_path (glob "$rports_base/rport-*") {
        my $pn = '';
        if (open my $fh, '<', "$rport_path/port_name") {
            local $/;
            ($pn = <$fh>) =~ s/\s+$//;
            close $fh;
        }
        if ($pn eq $wwpn) {
            my $name = (split m{/}, $rport_path)[-1];  # rport-H:B-I
            my ($h) = ($name =~ /^rport-(\d+):/);
            return defined $h ? $h + 0 : undef;
        }
    }
    return undef;
}
```

**Step 4: Run all tests**

```bash
prove -lv t/
```

Expected: all 16 tests in `t/05-wwid-discovery.t` pass, all other test files still pass.

**Step 5: Commit**

```bash
git add src/perl/PVE/API2/ISCSIMultipath.pm t/05-wwid-discovery.t
git commit -m "feat: add _fc_host_for_wwpn helper and complete wwid-discovery tests"
```

---

### Task 3: Backend endpoint — `GET /nodes/{node}/iscsi/multipath/wwid`

**Files:**
- Modify: `src/perl/PVE/API2/ISCSIMultipath.pm` (add register_method block before the `setup` endpoint)

**Step 1: Add the endpoint** — insert before the `setup` register_method block (before `__PACKAGE__->register_method({ name => 'setup'`):

```perl
__PACKAGE__->register_method({
    name        => 'get_wwid',
    path        => 'multipath/wwid',
    method      => 'GET',
    protected   => 1,
    proxyto     => 'node',
    description => 'Detect the multipath WWID for an iSCSI target or FC target.',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Audit']] },
    parameters  => {
        additionalProperties => 0,
        properties => {
            node       => get_standard_option('pve-node'),
            target_iqn => { type => 'string', optional => 1,
                            description => 'iSCSI Target IQN' },
            portal     => { type => 'string', optional => 1,
                            description => 'iSCSI portal IP:port' },
            fc_wwpn    => { type => 'string', optional => 1,
                            description => 'FC remote target WWPN' },
        },
    },
    returns => {
        type => 'object',
        properties => {
            wwid               => { type => 'string',  optional => 1 },
            already_configured => { type => 'boolean' },
            existing_alias     => { type => 'string',  optional => 1 },
        },
    },
    code => sub {
        my ($param) = @_;

        # Collect multipath -ll output (needed for both iSCSI and FC paths)
        my $mp_out = '';
        eval { _run_cmd(['multipath', '-ll'],
                        outfunc => sub { $mp_out .= $_[0] . "\n" },
                        errfunc => sub {}) };
        my $host_wwid_map = _build_host_wwid_map($mp_out);

        my $host_num;
        if ($param->{target_iqn} && $param->{portal}) {
            my $p3_out = '';
            eval { _run_cmd(['iscsiadm', '-m', 'session', '-P', '3'],
                            outfunc => sub { $p3_out .= $_[0] . "\n" },
                            errfunc => sub {}) };
            $host_num = _parse_session_host($p3_out, $param->{target_iqn}, $param->{portal});
        } elsif ($param->{fc_wwpn}) {
            $host_num = _fc_host_for_wwpn($param->{fc_wwpn});
        } else {
            die "Provide target_iqn+portal or fc_wwpn\n";
        }

        my $wwid = defined $host_num ? $host_wwid_map->{$host_num} : undef;
        return { wwid => undef, already_configured => 0 } unless $wwid;

        # Check if WWID already appears in /etc/multipath.conf
        my ($already, $existing_alias) = (0, undef);
        if (-f '/etc/multipath.conf') {
            open my $fh, '<', '/etc/multipath.conf'
                or die "Cannot read /etc/multipath.conf: $!\n";
            local $/;
            my $conf = <$fh>;
            close $fh;
            if ($conf =~ /\bwwid\s+\Q$wwid\E\b/) {
                $already = 1;
                # Extract alias from the same multipath{} block
                if ($conf =~ /multipath\s*\{[^}]*\balias\s+(\S+)[^}]*\bwwid\s+\Q$wwid\E/s ||
                    $conf =~ /multipath\s*\{[^}]*\bwwid\s+\Q$wwid\E[^}]*\balias\s+(\S+)/s) {
                    $existing_alias = $1;
                }
            }
        }

        return {
            wwid               => $wwid,
            already_configured => $already ? 1 : 0,
            $existing_alias ? (existing_alias => $existing_alias) : (),
        };
    },
});
```

**Step 2: Smoke-test via pvesh on the host**

```bash
ssh root@192.168.121.23 'pvesh get /nodes/cclabhost23/iscsi/multipath/wwid \
  --target_iqn iqn.XXXX --portal 192.168.X.X:3260'
```

Replace IQN and portal with a real session from `pvesh get /nodes/cclabhost23/iscsi/sessions`.
Expected: JSON with `wwid`, `already_configured`, and optionally `existing_alias`.

**Step 3: Run all tests (no regression)**

```bash
prove -lv t/
```

**Step 4: Commit**

```bash
git add src/perl/PVE/API2/ISCSIMultipath.pm
git commit -m "feat: add GET multipath/wwid endpoint for WWID auto-detection"
```

---

### Task 4: Backend endpoint — `POST /nodes/{node}/iscsi/multipath/add-device`

**Files:**
- Modify: `src/perl/PVE/API2/ISCSIMultipath.pm` (add register_method block after `get_wwid`)

**Step 1: Add the endpoint** — insert immediately after the closing `});` of the `get_wwid` endpoint:

```perl
__PACKAGE__->register_method({
    name        => 'add_multipath_device',
    path        => 'multipath/add-device',
    method      => 'POST',
    protected   => 1,
    proxyto     => 'node',
    description => 'Add a WWID + alias block to /etc/multipath.conf.',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Modify']] },
    parameters  => {
        additionalProperties => 0,
        properties => {
            node  => get_standard_option('pve-node'),
            wwid  => { type => 'string', description => 'Multipath device WWID' },
            alias => { type => 'string', description => 'Human-readable alias name' },
        },
    },
    returns => { type => 'null' },
    code => sub {
        my ($param) = @_;
        my ($wwid, $alias) = ($param->{wwid}, $param->{alias});

        my $existing = '';
        if (-f '/etc/multipath.conf') {
            open my $fh, '<', '/etc/multipath.conf'
                or die "Cannot read /etc/multipath.conf: $!\n";
            local $/;
            $existing = <$fh>;
            close $fh;
        }

        die "WWID $wwid is already configured in /etc/multipath.conf\n"
            if $existing =~ /\bwwid\s+\Q$wwid\E\b/;

        my $new_content = merge_multipath_config($existing, [{ wwid => $wwid, alias => $alias }]);

        open my $fh, '>', '/etc/multipath.conf'
            or die "Cannot write /etc/multipath.conf: $!\n";
        print $fh $new_content;
        close $fh;

        eval { _run_cmd(['multipathd', 'reconfigure'],
                        outfunc => sub {}, errfunc => sub {}) };

        return undef;
    },
});
```

**Step 2: Smoke-test via pvesh**

```bash
ssh root@192.168.121.23 'pvesh create /nodes/cclabhost23/iscsi/multipath/add-device \
  --wwid 36XXX --alias test-alias'
```

Use a real WWID found in the previous task's get_wwid test. Then verify:
```bash
ssh root@192.168.121.23 'grep -A3 "test-alias" /etc/multipath.conf'
```

**Step 3: Run all tests**

```bash
prove -lv t/
```

**Step 4: Commit**

```bash
git add src/perl/PVE/API2/ISCSIMultipath.pm
git commit -m "feat: add POST multipath/add-device endpoint"
```

---

### Task 5: Frontend — `PVE.node.ConfigureMultipathDialog`

**Files:**
- Modify: `src/js/pve-iscsi-multipath.js` (add new Ext.define block before `PVE.node.ISCSIPanel`)

**Step 1: Add the dialog class** — insert before the `Ext.define('PVE.node.ISCSIPanel'` line (line 5):

```javascript
Ext.define('PVE.node.ConfigureMultipathDialog', {
    extend: 'Ext.window.Window',
    xtype: 'pveConfigureMultipathDialog',

    title: gettext('Configure Multipath'),
    width: 450,
    modal: true,
    resizable: false,
    bodyPadding: 10,

    // Set by caller: nodename required; plus target_iqn+portal OR fc_wwpn
    nodename: null,
    target_iqn: null,
    portal: null,
    fc_wwpn: null,

    initComponent: function () {
        var me = this;

        var wwid = '';

        var wwid_display = Ext.create('Ext.form.field.Display', {
            fieldLabel: 'WWID',
            value: '',
        });

        var alias_field = Ext.create('Ext.form.field.Text', {
            fieldLabel: gettext('Alias'),
            allowBlank: false,
            validateOnBlur: false,
        });

        Ext.apply(me, {
            items: [wwid_display, alias_field],
            buttons: [
                {
                    text: gettext('Configure'),
                    itemId: 'configureBtn',
                    disabled: true,
                    handler: function () {
                        var alias = alias_field.getValue().trim();
                        if (!alias) {
                            alias_field.markInvalid(gettext('Alias is required'));
                            return;
                        }
                        Proxmox.Utils.API2Request({
                            url: '/nodes/' + me.nodename + '/iscsi/multipath/add-device',
                            method: 'POST',
                            params: { wwid: wwid, alias: alias },
                            waitMsgTarget: me,
                            success: function () {
                                me.fireEvent('configured');
                                me.close();
                            },
                            failure: function (r) {
                                Ext.Msg.alert(gettext('Error'), r.htmlStatus);
                            },
                        });
                    },
                },
                {
                    text: gettext('Cancel'),
                    handler: function () { me.close(); },
                },
            ],
        });

        me.callParent();

        // Discover WWID immediately on open
        me.setLoading(gettext('Detecting WWID\u2026'));

        var params = me.fc_wwpn
            ? { fc_wwpn: me.fc_wwpn }
            : { target_iqn: me.target_iqn, portal: me.portal };

        Proxmox.Utils.API2Request({
            url: '/api2/json/nodes/' + me.nodename + '/iscsi/multipath/wwid',
            method: 'GET',
            params: params,
            success: function (response) {
                me.setLoading(false);
                var d = response.result.data;

                if (!d.wwid) {
                    me.close();
                    Ext.Msg.alert(gettext('No Device Found'),
                        gettext('No multipath device detected for this target. ' +
                                'Ensure multipathd is running and the device is visible.'));
                    return;
                }
                if (d.already_configured) {
                    me.close();
                    Ext.Msg.alert(gettext('Already Configured'),
                        Ext.String.format(
                            gettext("WWID {0} is already configured as '{1}'."),
                            d.wwid,
                            d.existing_alias || '(unknown)'));
                    return;
                }

                wwid = d.wwid;
                wwid_display.setValue(d.wwid);
                me.down('#configureBtn').enable();
                alias_field.focus();
            },
            failure: function (r) {
                me.setLoading(false);
                me.close();
                Ext.Msg.alert(gettext('Error'), r.htmlStatus);
            },
        });
    },
});

```

**Step 2: Deploy and open browser devtools**

```bash
scp src/js/pve-iscsi-multipath.js root@192.168.121.23:/usr/share/pve-manager/js/pve-iscsi-multipath.js
```

Hard-reload the browser (Ctrl+Shift+R). No buttons yet — confirm no JS errors in the console.

**Step 3: Commit**

```bash
git add src/js/pve-iscsi-multipath.js
git commit -m "feat: add PVE.node.ConfigureMultipathDialog"
```

---

### Task 6: Frontend — "Configure Multipath" button in iSCSI Sessions grid

**Files:**
- Modify: `src/js/pve-iscsi-multipath.js` — inside `PVE.node.ISCSIPanel.initComponent`

**Step 1: Add the button to the sessions grid tbar**

In the `sessionsGrid` tbar array (after the existing Set Startup button, before the closing `],`), add:

```javascript
{
    text: gettext('Configure Multipath'),
    iconCls: 'fa fa-link',
    itemId: 'iscsiConfigMpBtn',
    disabled: true,
    handler: function () {
        var sel = sessionsGrid.getSelection();
        if (!sel.length) return;
        Ext.create('PVE.node.ConfigureMultipathDialog', {
            nodename: nodename,
            target_iqn: sel[0].get('target_iqn'),
            portal: sel[0].get('portal'),
        }).show();
    },
},
```

**Step 2: Add selectionchange listener to sessionsGrid**

Add a `listeners` property to the `sessionsGrid` Ext.create call (alongside `title`, `flex`, `store`, `columns`, `tbar`):

```javascript
listeners: {
    selectionchange: function (sm, selected) {
        sessionsGrid.down('#iscsiConfigMpBtn').setDisabled(!selected.length);
    },
},
```

**Step 3: Deploy and test**

```bash
scp src/js/pve-iscsi-multipath.js root@192.168.121.23:/usr/share/pve-manager/js/pve-iscsi-multipath.js
```

Hard-reload. In the iSCSI tab:
- Button should be disabled with no selection
- Select a session row → button enables
- Click button → loading spinner appears → WWID populates → alias field is focused
- Enter an alias, click Configure → entry appears in `/etc/multipath.conf`

**Step 4: Commit**

```bash
git add src/js/pve-iscsi-multipath.js
git commit -m "feat: add Configure Multipath button to iSCSI sessions grid"
```

---

### Task 7: Frontend — "Configure Multipath" button in FC Targets grid

The FC targets grid is currently an inline config object with no tbar or variable reference. It needs to be converted to a variable to support self-reference in the listener.

**Files:**
- Modify: `src/js/pve-iscsi-multipath.js` — inside `PVE.node.FCPanel.initComponent`

**Step 1: Convert inline FC targets grid to a variable**

Find the inline grid config inside `Ext.apply(me, { items: [...] })` for the `Connected FC Targets` grid (currently has no tbar). Replace the inline object with a variable reference:

Before (inside `Ext.apply(me, { items: [hbasGrid, { xtype: 'grid', title: 'Connected FC Targets'... }] })`):

The inline targets grid object becomes:

```javascript
var fcTargetsGrid = Ext.create('Ext.grid.Panel', {
    title: gettext('Connected FC Targets'),
    flex: 2,
    store: targetsStore,
    columns: [
        { text: 'Remote WWPN',      dataIndex: 'port_name',  flex: 2 },
        { text: gettext('Via HBA'), dataIndex: 'hba',        width: 70 },
        { text: gettext('State'),   dataIndex: 'port_state', width: 80, renderer: stateRenderer },
    ],
    tbar: [
        {
            text: gettext('Configure Multipath'),
            iconCls: 'fa fa-link',
            itemId: 'fcConfigMpBtn',
            disabled: true,
            handler: function () {
                var sel = fcTargetsGrid.getSelection();
                if (!sel.length) return;
                Ext.create('PVE.node.ConfigureMultipathDialog', {
                    nodename: nodename,
                    fc_wwpn: sel[0].get('port_name'),
                }).show();
            },
        },
    ],
    listeners: {
        selectionchange: function (sm, selected) {
            fcTargetsGrid.down('#fcConfigMpBtn').setDisabled(!selected.length);
        },
    },
});
```

And update `Ext.apply(me, { items: [...] })` to reference `fcTargetsGrid` instead of the inline object.

**Step 2: Deploy and test**

```bash
scp src/js/pve-iscsi-multipath.js root@192.168.121.23:/usr/share/pve-manager/js/pve-iscsi-multipath.js
```

Hard-reload. In the FC tab:
- "Connected FC Targets" grid should now have a toolbar
- Selecting an FC target row enables the button
- Clicking opens the dialog with WWID auto-detected from the FC WWPN

**Step 3: Run all backend tests one final time**

```bash
prove -lv t/
```

Expected: all tests pass.

**Step 4: Final commit**

```bash
git add src/js/pve-iscsi-multipath.js
git commit -m "feat: add Configure Multipath button to FC targets grid"
```

---

### Task 8: Build and deploy .deb

**Step 1: Rebuild the package**

```bash
cd /home/jpolansky/proxmox-storage-plugin
make deb
```

Expected: `pve-iscsi-multipath_0.2.0_all.deb` rebuilt.

**Step 2: Deploy to host**

```bash
scp pve-iscsi-multipath_0.2.0_all.deb root@192.168.121.23:/tmp/
ssh root@192.168.121.23 'dpkg -i /tmp/pve-iscsi-multipath_0.2.0_all.deb'
```

The postinst script restarts pveproxy and pvedaemon automatically.

**Step 3: Verify**

```bash
ssh root@192.168.121.23 'pvesh get /nodes/cclabhost23/iscsi/multipath/wwid --help'
# should show the new endpoint's parameter doc
```

Hard-reload the browser and test both iSCSI and FC Configure Multipath flows end-to-end.
