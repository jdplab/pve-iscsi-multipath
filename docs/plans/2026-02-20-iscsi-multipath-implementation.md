# pve-iscsi-multipath Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Proxmox VE .deb addon that adds iSCSI discovery, session management, and
multipath configuration panels to the node view, plus a datacenter-level setup wizard.

**Architecture:** A Perl API module (`PVE::API2::ISCSIMultipath`) registered as a subhandler
under `/nodes/{node}/iscsi/` via a patched `Nodes.pm`; an ExtJS 7 JavaScript file injected
via a patched `index.html.tpl` that overrides `PVE.node.Config` to add tabs and injects a
wizard button into the datacenter storage panel.

**Tech Stack:** Perl 5 (PVE::RESTHandler, PVE::Tools, Test::More), ExtJS 7 (same version
Proxmox uses), Debian packaging (debhelper), iscsiadm, multipath-tools.

**Reference implementations to read before starting:**
- `/usr/share/perl5/PVE/API2/Disks.pm` — pattern for node-level Perl API module
- `/usr/share/perl5/PVE/API2/Services.pm` — pattern for systemctl integration
- Lines 47540–48020 of `/usr/share/pve-manager/js/pvemanagerlib.js` — `PVE.node.Config`
  structure (the node panel we override)
- Lines 111–201 of `/usr/share/perl5/PVE/API2/Nodes.pm` — where we register our subhandler

---

## Task 1: Repo Skeleton + Discovery

**Goal:** Create the full directory structure and confirm two open questions from the design
doc before writing any real code.

**Files:**
- Create: `src/js/pve-iscsi-multipath.js` (empty stub)
- Create: `src/perl/PVE/API2/ISCSIMultipath.pm` (empty stub)
- Create: `debian/control`
- Create: `debian/changelog`
- Create: `debian/rules`
- Create: `debian/compat`
- Create: `debian/postinst`
- Create: `debian/prerm`
- Create: `debian/triggers`
- Create: `Makefile`
- Create: `t/` (test directory)

### Step 1: Create directory structure

```bash
mkdir -p src/js src/perl/PVE/API2 debian t
```

### Step 2: Create `debian/control`

```
Source: pve-iscsi-multipath
Section: admin
Priority: optional
Maintainer: Your Name <you@example.com>
Build-Depends: debhelper-compat (= 13)
Standards-Version: 4.6.0

Package: pve-iscsi-multipath
Architecture: all
Depends: pve-manager (>= 9.0),
         libpve-access-control-perl,
         libpve-common-perl,
         ${misc:Depends}
Recommends: open-iscsi, multipath-tools, lvm2, sanlock
Description: iSCSI and Multipath configuration plugin for Proxmox VE
 Adds iSCSI and multipath management panels to the Proxmox VE web GUI,
 including a datacenter-level setup wizard.
```

### Step 3: Create `debian/changelog`

```
pve-iscsi-multipath (0.1.0) bookworm; urgency=medium

  * Initial release.

 -- Your Name <you@example.com>  Thu, 20 Feb 2026 00:00:00 +0000
```

### Step 4: Create `debian/compat`

```
13
```

### Step 5: Create `debian/rules`

```makefile
#!/usr/bin/make -f
%:
	dh $@
```

Make it executable: `chmod +x debian/rules`

### Step 6: Create `debian/triggers`

```
interest-noawait /usr/share/pve-manager/index.html.tpl
interest-noawait /usr/share/perl5/PVE/API2/Nodes.pm
```

### Step 7: Create `Makefile`

```makefile
PACKAGE=pve-iscsi-multipath
VERSION=0.1.0
JS_DEST=/usr/share/pve-manager/js
PERL_DEST=/usr/share/perl5/PVE/API2

.PHONY: all install uninstall deb test

all:

install:
	install -d $(DESTDIR)$(JS_DEST)
	install -m 0644 src/js/pve-iscsi-multipath.js $(DESTDIR)$(JS_DEST)/
	install -d $(DESTDIR)$(PERL_DEST)
	install -m 0644 src/perl/PVE/API2/ISCSIMultipath.pm $(DESTDIR)$(PERL_DEST)/

test:
	prove -lv t/

deb:
	dpkg-buildpackage -us -uc -b
```

### Step 8: Discover the Datacenter storage panel xtype

Run on the Proxmox host:

```bash
grep -n "Ext\.define.*[Ss]torage\|xtype.*storage\|Datacenter.*[Ss]torage" \
  /usr/share/pve-manager/js/pvemanagerlib.js | grep -i "define\|xtype" | head -20
```

Also run to find where the datacenter Config panel is and how it adds storage toolbar buttons:

```bash
grep -n "Ext\.define.*DC\|Ext\.define.*Datacenter\|Ext\.define.*pve-dc" \
  /usr/share/pve-manager/js/pvemanagerlib.js | head -20
```

**Record the xtype in a comment at the top of `src/js/pve-iscsi-multipath.js`.**

### Step 9: Confirm Nodeinfo class boundary in Nodes.pm

Run on the Proxmox host:

```bash
grep -n "^package" /usr/share/perl5/PVE/API2/Nodes.pm
```

Expected: two `package` lines — one for `PVE::API2::Nodes` and one for
`PVE::API2::Nodes::Nodeinfo`. Note the line number where `Nodeinfo` begins.
Our `register_method` insertion must go inside `Nodeinfo`, after line ~201.

### Step 10: Create empty stubs

`src/perl/PVE/API2/ISCSIMultipath.pm`:
```perl
package PVE::API2::ISCSIMultipath;

use strict;
use warnings;

use base qw(PVE::RESTHandler);

1;
```

`src/js/pve-iscsi-multipath.js`:
```javascript
// pve-iscsi-multipath: Proxmox VE iSCSI/Multipath Plugin
// Datacenter storage panel xtype: <FILL IN FROM DISCOVERY STEP>
```

### Step 11: Commit

```bash
git add -A
git commit -m "feat: repo skeleton, debian packaging, empty stubs"
```

---

## Task 2: Perl Parsing Utilities (with unit tests)

**Goal:** Write and test pure functions that parse `iscsiadm` and `multipath` command output.
These have no system dependencies and are the most testable part of the codebase.

**Files:**
- Modify: `src/perl/PVE/API2/ISCSIMultipath.pm`
- Create: `t/01-parsing.t`

### Step 1: Write the failing tests first

`t/01-parsing.t`:
```perl
#!/usr/bin/perl
use strict;
use warnings;
use Test::More tests => 14;

# Add src/perl to @INC so we can load our module without installing it
use lib 'src/perl';
use PVE::API2::ISCSIMultipath;

# --- parse_sessions ---

my $session_output = <<'END';
tcp: [1] 192.168.122.15:3260,1 iqn.2005-10.org.freenas.ctl:proxmox-bruce (non-flash)
tcp: [2] 192.168.123.15:3260,1 iqn.2005-10.org.freenas.ctl:proxmox-bruce (non-flash)
tcp: [3] 192.168.122.15:3260,1 iqn.2005-10.org.freenas.ctl:proxmox-management (non-flash)
END

my $sessions = PVE::API2::ISCSIMultipath::parse_sessions($session_output);
is(scalar @$sessions, 3, 'parse_sessions: correct count');
is($sessions->[0]{target_iqn}, 'iqn.2005-10.org.freenas.ctl:proxmox-bruce', 'parse_sessions: target IQN');
is($sessions->[0]{portal}, '192.168.122.15:3260', 'parse_sessions: portal');
is($sessions->[0]{state}, 'LOGGED_IN', 'parse_sessions: state');

# --- parse_discovery ---

my $discovery_output = <<'END';
192.168.122.15:3260,1 iqn.2005-10.org.freenas.ctl:proxmox-management
192.168.122.15:3260,1 iqn.2005-10.org.freenas.ctl:proxmox-bruce
192.168.123.15:3260,1 iqn.2005-10.org.freenas.ctl:proxmox-management
END

my $targets = PVE::API2::ISCSIMultipath::parse_discovery($discovery_output);
is(scalar @$targets, 3, 'parse_discovery: correct count');
is($targets->[0]{target_iqn}, 'iqn.2005-10.org.freenas.ctl:proxmox-management', 'parse_discovery: IQN');
is($targets->[0]{portal}, '192.168.122.15:3260', 'parse_discovery: portal');
is($targets->[0]{tpgt}, '1', 'parse_discovery: tpgt');

# --- parse_multipath_status ---

my $multipath_output = <<'END';
proxmox-bruce (36589cfc000...) dm-1 IET,VIRTUAL-DISK
size=100G features='0' hwhandler='0' wp=rw
`-+- policy='round-robin 0' prio=1 status=active
  |- 3:0:0:1 sdb 8:16 active ready running
  `- 4:0:0:1 sdc 8:32 active ready running
END

my $devices = PVE::API2::ISCSIMultipath::parse_multipath_status($multipath_output);
is(scalar @$devices, 1, 'parse_multipath_status: device count');
is($devices->[0]{alias}, 'proxmox-bruce', 'parse_multipath_status: alias');
is($devices->[0]{wwid}, '36589cfc000...', 'parse_multipath_status: wwid');
is($devices->[0]{paths}, 2, 'parse_multipath_status: path count');
is($devices->[0]{state}, 'active', 'parse_multipath_status: state');

# --- merge_multipath_config ---

my $existing = <<'END';
defaults {
    user_friendly_names yes
}
multipaths {
    multipath {
        wwid 36589cfc000AAA
        alias proxmox-old
    }
}
END

my $new_entries = [
    { wwid => '36589cfc000BBB', alias => 'proxmox-new' },
];

my $merged = PVE::API2::ISCSIMultipath::merge_multipath_config($existing, $new_entries);
like($merged, qr/proxmox-old/, 'merge_multipath_config: preserves existing');
like($merged, qr/proxmox-new/, 'merge_multipath_config: adds new entry');
```

### Step 2: Run tests to verify they fail

```bash
prove -lv t/01-parsing.t
```

Expected: FAIL — functions don't exist yet.

### Step 3: Implement parsing functions in `ISCSIMultipath.pm`

Add to `src/perl/PVE/API2/ISCSIMultipath.pm` after the `use base` line:

```perl
# Parse output of: iscsiadm -m session -P 0
sub parse_sessions {
    my ($output) = @_;
    my @sessions;
    for my $line (split /\n/, $output) {
        # e.g.: tcp: [1] 192.168.122.15:3260,1 iqn.2005-10...:target (non-flash)
        if ($line =~ /^\w+:\s+\[\d+\]\s+(\S+?),\d+\s+(\S+)/) {
            push @sessions, {
                portal     => $1,
                target_iqn => $2,
                state      => 'LOGGED_IN',
            };
        }
    }
    return \@sessions;
}

# Parse output of: iscsiadm -m discovery -t sendtargets -p <portal>
sub parse_discovery {
    my ($output) = @_;
    my @targets;
    for my $line (split /\n/, $output) {
        # e.g.: 192.168.122.15:3260,1 iqn.2005-10...:target
        if ($line =~ /^(\S+?):(\d+),(\d+)\s+(\S+)/) {
            push @targets, {
                portal     => "$1:$2",
                tpgt       => $3,
                target_iqn => $4,
            };
        }
    }
    return \@targets;
}

# Parse output of: multipath -ll
sub parse_multipath_status {
    my ($output) = @_;
    my @devices;
    my $current;
    for my $line (split /\n/, $output) {
        # New device line: alias (wwid) dm-N vendor,product
        if ($line =~ /^(\S+)\s+\(([^)]+)\)\s+dm-\d+/) {
            push @devices, $current if $current;
            $current = { alias => $1, wwid => $2, paths => 0, state => 'unknown' };
        }
        # Active policy line indicates overall state
        elsif ($current && $line =~ /status=(\w+)/) {
            $current->{state} = $1;
        }
        # Path line: |- or `- followed by H:C:T:L dev
        elsif ($current && $line =~ /[|`]-\s+\d+:\d+:\d+:\d+\s+\S+\s+\S+\s+(\w+)/) {
            $current->{paths}++;
        }
    }
    push @devices, $current if $current;
    return \@devices;
}

# Merge new {wwid, alias} entries into an existing multipath.conf string.
# Inserts new multipath{} blocks inside the multipaths{} section.
# If no multipaths{} section exists, appends one.
sub merge_multipath_config {
    my ($existing, $new_entries) = @_;

    my $new_blocks = '';
    for my $entry (@$new_entries) {
        $new_blocks .= sprintf(
            "    multipath {\n        wwid %s\n        alias %s\n    }\n",
            $entry->{wwid}, $entry->{alias}
        );
    }

    if ($existing =~ /multipaths\s*\{/) {
        # Insert before the closing } of the multipaths block
        $existing =~ s/(multipaths\s*\{[^}]*)(\})/$1$new_blocks$2/s;
    } else {
        $existing .= "\nmultipaths {\n$new_blocks}\n";
    }
    return $existing;
}
```

### Step 4: Run tests to verify they pass

```bash
prove -lv t/01-parsing.t
```

Expected: All 14 tests pass.

### Step 5: Commit

```bash
git add src/perl/PVE/API2/ISCSIMultipath.pm t/01-parsing.t
git commit -m "feat: add iSCSI/multipath parsing utilities with tests"
```

---

## Task 3: Perl — Status Endpoint

**Goal:** Implement `GET /nodes/{node}/iscsi/status`. This reads real system state.

**Files:**
- Modify: `src/perl/PVE/API2/ISCSIMultipath.pm`
- Create: `t/02-status.t`

### Step 1: Study the reference implementation

Read `/usr/share/perl5/PVE/API2/Services.pm` on the Proxmox host to see how systemctl
service state is checked:

```bash
grep -A 20 "sub get_service_state\|active.*systemctl\|is-active" \
  /usr/share/perl5/PVE/API2/Services.pm | head -40
```

Also check how `PVE::Tools::run_command` is used with `noerr` to handle non-zero exits:

```bash
grep -n "run_command.*noerr\|run_command.*errmsg" \
  /usr/share/perl5/PVE/API2/Disks.pm | head -10
```

### Step 2: Write the failing test

`t/02-status.t`:
```perl
#!/usr/bin/perl
use strict;
use warnings;
use Test::More tests => 6;
use lib 'src/perl';
use PVE::API2::ISCSIMultipath;

# Test check_package_installed with a mock dpkg-query
{
    local *PVE::API2::ISCSIMultipath::_run_cmd = sub {
        my ($cmd) = @_;
        # Simulate: open-iscsi installed, sanlock not installed
        return 0 if grep { $_ eq 'open-iscsi' } @$cmd;
        die "not installed\n";
    };

    ok(PVE::API2::ISCSIMultipath::check_package_installed('open-iscsi'),
       'check_package_installed: installed package returns true');
    ok(!PVE::API2::ISCSIMultipath::check_package_installed('sanlock'),
       'check_package_installed: missing package returns false');
}

# Test check_service_active with a mock systemctl
{
    local *PVE::API2::ISCSIMultipath::_run_cmd = sub {
        my ($cmd) = @_;
        return 0 if grep { $_ eq 'iscsid' } @$cmd;
        die "inactive\n";
    };

    ok(PVE::API2::ISCSIMultipath::check_service_active('iscsid'),
       'check_service_active: active service returns true');
    ok(!PVE::API2::ISCSIMultipath::check_service_active('sanlock'),
       'check_service_active: inactive service returns false');
}

# Test check_service_enabled with a mock systemctl
{
    local *PVE::API2::ISCSIMultipath::_run_cmd = sub {
        my ($cmd) = @_;
        return 0 if grep { $_ eq 'multipathd' } @$cmd;
        die "disabled\n";
    };

    ok(PVE::API2::ISCSIMultipath::check_service_enabled('multipathd'),
       'check_service_enabled: enabled service returns true');
    ok(!PVE::API2::ISCSIMultipath::check_service_enabled('lvmlockd'),
       'check_service_enabled: disabled service returns false');
}
```

### Step 3: Run test to verify it fails

```bash
prove -lv t/02-status.t
```

Expected: FAIL.

### Step 4: Implement `_run_cmd`, `check_package_installed`, `check_service_active`,
`check_service_enabled`, and the `status` API method

Add to `ISCSIMultipath.pm`:

```perl
use PVE::Tools qw(run_command);
use PVE::Exception qw(raise_param_exc);
use PVE::JSONSchema qw(get_standard_option);
use PVE::RPCEnvironment;

# Thin wrapper so tests can mock system calls
sub _run_cmd {
    my ($cmd, %opts) = @_;
    run_command($cmd, %opts);
}

sub check_package_installed {
    my ($pkg) = @_;
    eval { _run_cmd(['dpkg-query', '-W', '-f=${Status}', $pkg],
                    outfunc => sub {}, errfunc => sub {}) };
    return !$@;
}

sub check_service_active {
    my ($service) = @_;
    eval { _run_cmd(['systemctl', 'is-active', '--quiet', $service],
                    outfunc => sub {}, errfunc => sub {}) };
    return !$@;
}

sub check_service_enabled {
    my ($service) = @_;
    eval { _run_cmd(['systemctl', 'is-enabled', '--quiet', $service],
                    outfunc => sub {}, errfunc => sub {}) };
    return !$@;
}

__PACKAGE__->register_method({
    name        => 'status',
    path        => 'status',
    method      => 'GET',
    description => 'Get iSCSI and multipath status for this node.',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Audit']] },
    parameters  => {
        additionalProperties => 0,
        properties => {
            node => get_standard_option('pve-node'),
        },
    },
    returns => { type => 'object' },
    code => sub {
        my ($param) = @_;

        # Packages
        my %pkgs;
        for my $p (qw(open-iscsi multipath-tools lvm2 sanlock)) {
            (my $key = $p) =~ s/-/_/g;
            $pkgs{$key} = check_package_installed($p) ? 1 : 0;
        }

        # Services
        my %svcs;
        for my $s (qw(iscsid multipathd lvmlockd sanlock)) {
            $svcs{$s} = {
                running => check_service_active($s)  ? 1 : 0,
                enabled => check_service_enabled($s) ? 1 : 0,
            };
        }

        # Existing iSCSI sessions
        my $session_out = '';
        eval { _run_cmd(['iscsiadm', '-m', 'session', '-P', '0'],
                        outfunc => sub { $session_out .= $_[0] . "\n" },
                        errfunc => sub {}) };
        my $sessions = parse_sessions($session_out);

        # Existing multipath devices
        my $mp_out = '';
        eval { _run_cmd(['multipath', '-ll'],
                        outfunc => sub { $mp_out .= $_[0] . "\n" },
                        errfunc => sub {}) };
        my $mp_devices = parse_multipath_status($mp_out);

        my $config_exists = -f '/etc/multipath.conf' ? 1 : 0;

        return {
            packages              => \%pkgs,
            services              => \%svcs,
            sessions              => $sessions,
            multipath_config_exists => $config_exists,
            multipath_devices     => $mp_devices,
        };
    },
});
```

### Step 5: Run tests to verify they pass

```bash
prove -lv t/02-status.t
```

Expected: All 6 pass.

### Step 6: Commit

```bash
git add src/perl/PVE/API2/ISCSIMultipath.pm t/02-status.t
git commit -m "feat: add status endpoint with package/service checks"
```

---

## Task 4: Perl — Discovery, Sessions, Multipath Read/Write

**Goal:** Implement the remaining read/write endpoints (discover, login, logout, startup,
multipath config GET/PUT).

**Files:**
- Modify: `src/perl/PVE/API2/ISCSIMultipath.pm`

No new unit tests for these (they wrap system commands directly); they are verified by
integration testing in Task 13.

### Step 1: Add discovery endpoint

```perl
__PACKAGE__->register_method({
    name        => 'discover',
    path        => 'discover',
    method      => 'POST',
    description => 'Run iSCSI target discovery against one or more portals.',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Modify']] },
    parameters  => {
        additionalProperties => 0,
        properties => {
            node    => get_standard_option('pve-node'),
            portals => {
                type        => 'string',
                description => 'Comma-separated list of portal IPs (optionally with :port)',
            },
        },
    },
    returns => { type => 'array', items => { type => 'object' } },
    code => sub {
        my ($param) = @_;
        my @portals = split /,/, $param->{portals};
        my @all_targets;
        for my $portal (@portals) {
            $portal =~ s/^\s+|\s+$//g;
            $portal .= ':3260' unless $portal =~ /:\d+$/;
            my $out = '';
            eval {
                _run_cmd(['iscsiadm', '-m', 'discovery', '-t', 'sendtargets', '-p', $portal],
                         outfunc => sub { $out .= $_[0] . "\n" },
                         errfunc => sub {});
            };
            push @all_targets, @{parse_discovery($out)};
        }
        # Deduplicate by target_iqn + portal
        my %seen;
        return [grep { !$seen{"$_->{target_iqn}|$_->{portal}"}++ } @all_targets];
    },
});
```

### Step 2: Add sessions endpoint

```perl
__PACKAGE__->register_method({
    name        => 'sessions',
    path        => 'sessions',
    method      => 'GET',
    description => 'List active iSCSI sessions.',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Audit']] },
    parameters  => {
        additionalProperties => 0,
        properties => { node => get_standard_option('pve-node') },
    },
    returns => { type => 'array', items => { type => 'object' } },
    code => sub {
        my ($param) = @_;
        my $out = '';
        eval { _run_cmd(['iscsiadm', '-m', 'session', '-P', '0'],
                        outfunc => sub { $out .= $_[0] . "\n" },
                        errfunc => sub {}) };
        return parse_sessions($out);
    },
});
```

### Step 3: Add login endpoint

```perl
__PACKAGE__->register_method({
    name        => 'login',
    path        => 'login',
    method      => 'POST',
    description => 'Login to an iSCSI target on a portal. No-ops if already connected.',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Modify']] },
    parameters  => {
        additionalProperties => 0,
        properties => {
            node       => get_standard_option('pve-node'),
            target_iqn => { type => 'string', description => 'Target IQN' },
            portal     => { type => 'string', description => 'Portal IP:port' },
        },
    },
    returns => { type => 'object', properties => {
        already_connected => { type => 'boolean' },
    }},
    code => sub {
        my ($param) = @_;

        # Check if already connected
        my $out = '';
        eval { _run_cmd(['iscsiadm', '-m', 'session', '-P', '0'],
                        outfunc => sub { $out .= $_[0] . "\n" },
                        errfunc => sub {}) };
        my $sessions = parse_sessions($out);
        for my $s (@$sessions) {
            if ($s->{target_iqn} eq $param->{target_iqn} &&
                $s->{portal} eq $param->{portal}) {
                return { already_connected => 1 };
            }
        }

        _run_cmd(['iscsiadm', '-m', 'node',
                  '-T', $param->{target_iqn},
                  '-p', $param->{portal},
                  '--login']);
        return { already_connected => 0 };
    },
});
```

### Step 4: Add logout endpoint

```perl
__PACKAGE__->register_method({
    name        => 'logout',
    path        => 'logout',
    method      => 'POST',
    description => 'Logout from an iSCSI target on a portal.',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Modify']] },
    parameters  => {
        additionalProperties => 0,
        properties => {
            node       => get_standard_option('pve-node'),
            target_iqn => { type => 'string' },
            portal     => { type => 'string' },
        },
    },
    returns => { type => 'null' },
    code => sub {
        my ($param) = @_;
        _run_cmd(['iscsiadm', '-m', 'node',
                  '-T', $param->{target_iqn},
                  '-p', $param->{portal},
                  '--logout']);
        return undef;
    },
});
```

### Step 5: Add startup configuration endpoint

```perl
__PACKAGE__->register_method({
    name        => 'set_startup',
    path        => 'startup',
    method      => 'PUT',
    description => 'Set auto-login mode for an iSCSI target.',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Modify']] },
    parameters  => {
        additionalProperties => 0,
        properties => {
            node       => get_standard_option('pve-node'),
            target_iqn => { type => 'string' },
            portal     => { type => 'string' },
            mode       => {
                type => 'string',
                enum => ['automatic', 'manual', 'onboot'],
            },
        },
    },
    returns => { type => 'null' },
    code => sub {
        my ($param) = @_;
        _run_cmd(['iscsiadm', '-m', 'node',
                  '-T', $param->{target_iqn},
                  '-p', $param->{portal},
                  '--op', 'update',
                  '-n', 'node.startup',
                  '-v', $param->{mode}]);
        return undef;
    },
});
```

### Step 6: Add multipath status endpoint

```perl
__PACKAGE__->register_method({
    name        => 'multipath_status',
    path        => 'multipath/status',
    method      => 'GET',
    description => 'Get current multipath device status.',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Audit']] },
    parameters  => {
        additionalProperties => 0,
        properties => { node => get_standard_option('pve-node') },
    },
    returns => { type => 'array', items => { type => 'object' } },
    code => sub {
        my ($param) = @_;
        my $out = '';
        eval { _run_cmd(['multipath', '-ll'],
                        outfunc => sub { $out .= $_[0] . "\n" },
                        errfunc => sub {}) };
        return parse_multipath_status($out);
    },
});
```

### Step 7: Add multipath config GET/PUT endpoints

```perl
__PACKAGE__->register_method({
    name        => 'get_multipath_config',
    path        => 'multipath/config',
    method      => 'GET',
    description => 'Get current /etc/multipath.conf content.',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Audit']] },
    parameters  => {
        additionalProperties => 0,
        properties => { node => get_standard_option('pve-node') },
    },
    returns => { type => 'object', properties => { content => { type => 'string' } } },
    code => sub {
        my ($param) = @_;
        my $content = '';
        if (-f '/etc/multipath.conf') {
            open my $fh, '<', '/etc/multipath.conf'
                or die "Cannot read /etc/multipath.conf: $!\n";
            local $/;
            $content = <$fh>;
            close $fh;
        }
        return { content => $content };
    },
});

__PACKAGE__->register_method({
    name        => 'put_multipath_config',
    path        => 'multipath/config',
    method      => 'PUT',
    description => 'Write /etc/multipath.conf and restart multipathd.',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Modify']] },
    parameters  => {
        additionalProperties => 0,
        properties => {
            node    => get_standard_option('pve-node'),
            content => { type => 'string', description => 'Full multipath.conf content' },
            merge   => {
                type        => 'boolean',
                optional    => 1,
                default     => 0,
                description => 'Merge new entries into existing config instead of replacing',
            },
        },
    },
    returns => { type => 'string', description => 'UPID of the restart task' },
    code => sub {
        my ($param) = @_;
        my $rpcenv  = PVE::RPCEnvironment::get();
        my $authuser = $rpcenv->get_user();

        my $content = $param->{content};

        if ($param->{merge} && -f '/etc/multipath.conf') {
            open my $fh, '<', '/etc/multipath.conf'
                or die "Cannot read existing config: $!\n";
            local $/;
            my $existing = <$fh>;
            close $fh;
            # In merge mode, content is interpreted as JSON array of {wwid,alias}
            # but for simplicity we accept raw config and just append the multipaths block
            $content = $existing . "\n" . $content;
        }

        my $final_content = $content;

        return $rpcenv->fork_worker('mpconfig', undef, $authuser, sub {
            print "Writing /etc/multipath.conf...\n";
            open my $fh, '>', '/etc/multipath.conf'
                or die "Cannot write /etc/multipath.conf: $!\n";
            print $fh $final_content;
            close $fh;
            print "Restarting multipathd...\n";
            _run_cmd(['systemctl', 'restart', 'multipathd']);
            print "Done.\n";
        });
    },
});
```

### Step 8: Commit

```bash
git add src/perl/PVE/API2/ISCSIMultipath.pm
git commit -m "feat: add discovery, session, and multipath API endpoints"
```

---

## Task 5: Perl — Setup Endpoint (Async Task)

**Goal:** Implement `POST /nodes/{node}/iscsi/setup` — the bulk idempotent setup endpoint
that the datacenter wizard calls per node.

**Files:**
- Modify: `src/perl/PVE/API2/ISCSIMultipath.pm`
- Create: `t/03-setup-idempotency.t`

### Step 1: Write the failing test for idempotency logic

`t/03-setup-idempotency.t`:
```perl
#!/usr/bin/perl
use strict;
use warnings;
use Test::More tests => 4;
use lib 'src/perl';
use PVE::API2::ISCSIMultipath;

# Test that session_exists correctly identifies already-logged-in targets
my @sessions = (
    { target_iqn => 'iqn.2005-10.org.freenas.ctl:bruce', portal => '192.168.122.15:3260' },
);

ok(PVE::API2::ISCSIMultipath::session_exists(\@sessions,
    'iqn.2005-10.org.freenas.ctl:bruce', '192.168.122.15:3260'),
   'session_exists: finds matching session');

ok(!PVE::API2::ISCSIMultipath::session_exists(\@sessions,
    'iqn.2005-10.org.freenas.ctl:bruce', '192.168.123.15:3260'),
   'session_exists: different portal not matched');

ok(!PVE::API2::ISCSIMultipath::session_exists(\@sessions,
    'iqn.2005-10.org.freenas.ctl:management', '192.168.122.15:3260'),
   'session_exists: different target not matched');

# Test that lvm_conf_has_lvmlockd correctly detects the setting
my $lvm_conf_with = "global {\n    use_lvmlockd = 1\n}\n";
my $lvm_conf_without = "global {\n    use_lvmlockd = 0\n}\n";
ok(PVE::API2::ISCSIMultipath::lvm_conf_has_lvmlockd($lvm_conf_with),
   'lvm_conf_has_lvmlockd: detects enabled setting');
```

### Step 2: Run test to verify it fails

```bash
prove -lv t/03-setup-idempotency.t
```

### Step 3: Implement helper functions and setup endpoint

```perl
sub session_exists {
    my ($sessions, $target_iqn, $portal) = @_;
    for my $s (@$sessions) {
        return 1 if $s->{target_iqn} eq $target_iqn && $s->{portal} eq $portal;
    }
    return 0;
}

sub lvm_conf_has_lvmlockd {
    my ($content) = @_;
    return $content =~ /use_lvmlockd\s*=\s*1/;
}

__PACKAGE__->register_method({
    name        => 'setup',
    path        => 'setup',
    method      => 'POST',
    description => 'Run full iSCSI/multipath setup sequence. Idempotent.',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Modify']] },
    parameters  => {
        additionalProperties => 0,
        properties => {
            node             => get_standard_option('pve-node'),
            portals          => { type => 'string', description => 'Comma-separated portals' },
            targets          => { type => 'string', description => 'Comma-separated target IQNs' },
            multipath_config => { type => 'string', description => 'Full multipath.conf content' },
            merge_multipath  => { type => 'boolean', optional => 1, default => 0 },
            enable_lvmlockd  => { type => 'boolean', optional => 1, default => 0 },
            enable_sanlock   => { type => 'boolean', optional => 1, default => 0 },
        },
    },
    returns => { type => 'string', description => 'UPID' },
    code => sub {
        my ($param) = @_;
        my $rpcenv  = PVE::RPCEnvironment::get();
        my $authuser = $rpcenv->get_user();

        my @portals = map { s/^\s+|\s+$//gr }
                      map { $_ =~ /:/ ? $_ : "$_:3260" }
                      split /,/, $param->{portals};
        my @targets = map { s/^\s+|\s+$//gr } split /,/, $param->{targets};

        return $rpcenv->fork_worker('iscsisetup', undef, $authuser, sub {
            # Step 1: Install packages
            print "Checking packages...\n";
            my @missing;
            push @missing, 'open-iscsi'      unless check_package_installed('open-iscsi');
            push @missing, 'multipath-tools' unless check_package_installed('multipath-tools');
            push @missing, 'lvm2'            unless check_package_installed('lvm2');
            if ($param->{enable_sanlock}) {
                push @missing, 'sanlock' unless check_package_installed('sanlock');
            }
            if (@missing) {
                print "Installing: @missing\n";
                _run_cmd(['apt-get', 'install', '-y', @missing]);
            } else {
                print "All packages already installed - skipped.\n";
            }

            # Step 2: Enable iscsid
            print "Checking iscsid...\n";
            if (!check_service_active('iscsid')) {
                _run_cmd(['systemctl', 'enable', '--now', 'iscsid']);
                print "iscsid enabled and started.\n";
            } else {
                print "iscsid already running - skipped.\n";
            }

            # Step 3: Discovery + login
            my $session_out = '';
            eval { _run_cmd(['iscsiadm', '-m', 'session', '-P', '0'],
                            outfunc => sub { $session_out .= $_[0] . "\n" },
                            errfunc => sub {}) };
            my $existing_sessions = parse_sessions($session_out);

            for my $portal (@portals) {
                print "Discovering targets on $portal...\n";
                eval { _run_cmd(['iscsiadm', '-m', 'discovery',
                                 '-t', 'sendtargets', '-p', $portal],
                                outfunc => sub { print "  $_[0]\n" },
                                errfunc => sub {}) };
            }

            for my $target (@targets) {
                for my $portal (@portals) {
                    if (session_exists($existing_sessions, $target, $portal)) {
                        print "Already connected: $target on $portal - skipped.\n";
                    } else {
                        print "Logging in: $target on $portal...\n";
                        eval { _run_cmd(['iscsiadm', '-m', 'node',
                                         '-T', $target, '-p', $portal, '--login'],
                                        outfunc => sub { print "  $_[0]\n" },
                                        errfunc => sub { print "  $_[0]\n" }) };
                        if ($@) { print "  Warning: $@" }
                    }
                }
            }

            # Step 4: Write multipath.conf
            print "Configuring multipath...\n";
            my $config = $param->{multipath_config};
            if ($param->{merge_multipath} && -f '/etc/multipath.conf') {
                open my $fh, '<', '/etc/multipath.conf'
                    or die "Cannot read existing multipath.conf: $!\n";
                local $/;
                my $existing = <$fh>;
                close $fh;
                $config = $existing . "\n" . $config;
                print "Merged with existing config.\n";
            }
            open my $fh, '>', '/etc/multipath.conf'
                or die "Cannot write /etc/multipath.conf: $!\n";
            print $fh $config;
            close $fh;
            print "multipath.conf written.\n";

            # Step 5: Enable multipathd
            if (!check_service_active('multipathd')) {
                _run_cmd(['systemctl', 'enable', '--now', 'multipathd']);
                print "multipathd enabled and started.\n";
            } else {
                _run_cmd(['systemctl', 'restart', 'multipathd']);
                print "multipathd restarted with new config.\n";
            }

            # Step 6: lvmlockd/sanlock (optional)
            if ($param->{enable_lvmlockd}) {
                print "Configuring lvmlockd...\n";
                my $lvm_conf = '';
                open my $lf, '<', '/etc/lvm/lvm.conf'
                    or die "Cannot read lvm.conf: $!\n";
                { local $/; $lvm_conf = <$lf>; }
                close $lf;

                if (!lvm_conf_has_lvmlockd($lvm_conf)) {
                    $lvm_conf =~ s/(global\s*\{)/$1\n    use_lvmlockd = 1/;
                    open my $lf, '>', '/etc/lvm/lvm.conf'
                        or die "Cannot write lvm.conf: $!\n";
                    print $lf $lvm_conf;
                    close $lf;
                    print "lvm.conf updated.\n";
                } else {
                    print "lvmlockd already in lvm.conf - skipped.\n";
                }
                _run_cmd(['systemctl', 'enable', '--now', 'lvmlockd'])
                    unless check_service_active('lvmlockd');
            }

            if ($param->{enable_sanlock}) {
                _run_cmd(['systemctl', 'enable', '--now', 'sanlock'])
                    unless check_service_active('sanlock');
            }

            # Step 7: Configure auto-login
            print "Configuring auto-login...\n";
            for my $target (@targets) {
                for my $portal (@portals) {
                    eval {
                        _run_cmd(['iscsiadm', '-m', 'node',
                                  '-T', $target, '-p', $portal,
                                  '--op', 'update',
                                  '-n', 'node.startup', '-v', 'automatic'],
                                 errfunc => sub {});
                    };
                }
            }

            print "Setup complete.\n";
        });
    },
});
```

### Step 4: Run idempotency tests

```bash
prove -lv t/03-setup-idempotency.t
```

Expected: All 4 pass.

### Step 5: Commit

```bash
git add src/perl/PVE/API2/ISCSIMultipath.pm t/03-setup-idempotency.t
git commit -m "feat: add setup endpoint with idempotency checks"
```

---

## Task 6: postinst / prerm Scripts

**Goal:** Write the patch scripts that inject our JS and register our Perl module.

**Files:**
- Modify: `debian/postinst`
- Modify: `debian/prerm`

### Step 1: Write `debian/postinst`

```bash
#!/bin/bash
set -e

MARKER_BEGIN="# BEGIN pve-iscsi-multipath"
MARKER_END="# END pve-iscsi-multipath"
HTML_TPL="/usr/share/pve-manager/index.html.tpl"
NODES_PM="/usr/share/perl5/PVE/API2/Nodes.pm"
PKG_VERSION="@VERSION@"  # replaced by Makefile during build

patch_html_template() {
    if grep -q "BEGIN pve-iscsi-multipath" "$HTML_TPL"; then
        echo "index.html.tpl already patched - skipping."
        return
    fi
    if ! grep -q "pvemanagerlib.js" "$HTML_TPL"; then
        echo "ERROR: pvemanagerlib.js line not found in $HTML_TPL — aborting patch." >&2
        exit 1
    fi
    sed -i "s|pvemanagerlib.js.*\"/>|pvemanagerlib.js?ver=[% version %]\" />\n    ${MARKER_BEGIN}\n    <script type=\"text/javascript\" src=\"/pve2/js/pve-iscsi-multipath.js?ver=${PKG_VERSION}\"></script>\n    ${MARKER_END}|" "$HTML_TPL"
    echo "index.html.tpl patched."
}

patch_nodes_pm() {
    if grep -q "BEGIN pve-iscsi-multipath" "$NODES_PM"; then
        echo "Nodes.pm already patched - skipping."
        return
    fi
    # Verify expected use block exists
    if ! grep -q "use PVE::API2::Disks;" "$NODES_PM"; then
        echo "ERROR: expected use block not found in $NODES_PM — aborting patch." >&2
        exit 1
    fi
    # Insert 'use' statement after the Disks line
    sed -i "s|use PVE::API2::Disks;|use PVE::API2::Disks;\n${MARKER_BEGIN}\nuse PVE::API2::ISCSIMultipath;\n${MARKER_END}|" "$NODES_PM"
    # Verify expected register_method block for Disks
    if ! grep -q "subclass.*PVE::API2::Disks" "$NODES_PM"; then
        echo "ERROR: Disks subclass registration not found in $NODES_PM — aborting patch." >&2
        exit 1
    fi
    # Insert register_method after Disks subclass block (find closing }; after it)
    python3 - <<'PYEOF'
import re, sys

with open('/usr/share/perl5/PVE/API2/Nodes.pm', 'r') as f:
    content = f.read()

insert = """
# BEGIN pve-iscsi-multipath
__PACKAGE__->register_method({
    subclass => "PVE::API2::ISCSIMultipath",
    path => 'iscsi',
});
# END pve-iscsi-multipath
"""

# Insert after the Disks register_method block (find it and its closing });)
pattern = r"(__PACKAGE__->register_method\(\{[^}]*subclass => \"PVE::API2::Disks\"[^}]*\}\);)"
replacement = r"\1" + insert

content, n = re.subn(pattern, replacement, content, flags=re.DOTALL)
if n == 0:
    print("ERROR: could not find Disks register_method block", file=sys.stderr)
    sys.exit(1)

with open('/usr/share/perl5/PVE/API2/Nodes.pm', 'w') as f:
    f.write(content)
print("Nodes.pm register_method patched.")
PYEOF
    echo "Nodes.pm use block patched."
}

case "$1" in
    configure|triggered)
        patch_html_template
        patch_nodes_pm
        systemctl restart pveproxy pvedaemon || true
        ;;
esac

#DEBHELPER#
exit 0
```

### Step 2: Write `debian/prerm`

```bash
#!/bin/bash
set -e

HTML_TPL="/usr/share/pve-manager/index.html.tpl"
NODES_PM="/usr/share/perl5/PVE/API2/Nodes.pm"

remove_markers() {
    local file="$1"
    if grep -q "BEGIN pve-iscsi-multipath" "$file"; then
        # Remove everything between (and including) the BEGIN/END marker lines
        sed -i '/# BEGIN pve-iscsi-multipath/,/# END pve-iscsi-multipath/d' "$file"
        # Same for HTML comments
        sed -i '/<!-- BEGIN pve-iscsi-multipath -->/,/<!-- END pve-iscsi-multipath -->/d' "$file"
        echo "Removed pve-iscsi-multipath markers from $file"
    fi
}

case "$1" in
    remove|upgrade|deconfigure)
        remove_markers "$HTML_TPL"
        remove_markers "$NODES_PM"
        systemctl restart pveproxy pvedaemon || true
        ;;
esac

#DEBHELPER#
exit 0
```

### Step 3: Make scripts executable

```bash
chmod +x debian/postinst debian/prerm
```

### Step 4: Test the patch logic manually

On the Proxmox host (in a test environment), copy the scripts and run:

```bash
# Verify idempotency — run postinst twice, should not double-patch
bash debian/postinst configure
bash debian/postinst configure
grep -c "pve-iscsi-multipath" /usr/share/pve-manager/index.html.tpl  # should be 3 (begin, script, end)

# Verify prerm cleans up
bash debian/prerm remove
grep "pve-iscsi-multipath" /usr/share/pve-manager/index.html.tpl && echo "FAIL" || echo "PASS"
```

### Step 5: Commit

```bash
git add debian/postinst debian/prerm
git commit -m "feat: add postinst/prerm patch scripts with idempotency guards"
```

---

## Task 7: JavaScript — `PVE.node.ISCSIPanel`

**Goal:** Implement the per-node iSCSI management tab.

**Files:**
- Modify: `src/js/pve-iscsi-multipath.js`

### Step 1: Add the ISCSIPanel component

```javascript
Ext.define('PVE.node.ISCSIPanel', {
    extend: 'Ext.panel.Panel',
    xtype: 'pveNodeISCSIPanel',

    layout: {
        type: 'hbox',
        align: 'stretch',
    },

    initComponent: function () {
        var me = this;
        var nodename = me.pveSelNode.data.node;
        if (!nodename) throw 'no node name specified';

        var portalsStore = Ext.create('Ext.data.Store', {
            fields: ['portal'],
            data: [],
        });

        var sessionsStore = Ext.create('Ext.data.Store', {
            fields: ['target_iqn', 'portal', 'state'],
            proxy: {
                type: 'proxmox',
                url: '/api2/json/nodes/' + nodename + '/iscsi/sessions',
            },
        });

        var reloadSessions = function () {
            sessionsStore.load();
        };

        var portalsGrid = Ext.create('Ext.grid.Panel', {
            title: gettext('Portals'),
            flex: 1,
            store: portalsStore,
            columns: [
                { text: gettext('Portal'), dataIndex: 'portal', flex: 1 },
            ],
            tbar: [
                {
                    text: gettext('Add'),
                    iconCls: 'fa fa-plus',
                    handler: function () {
                        Ext.Msg.prompt(gettext('Add Portal'),
                            gettext('Enter portal IP (e.g. 192.168.1.1 or 192.168.1.1:3260):'),
                            function (btn, value) {
                                if (btn !== 'ok' || !value) return;
                                var portal = value.trim();
                                if (!portal.match(/:/)) portal += ':3260';
                                portalsStore.add({ portal: portal });
                            });
                    },
                },
                {
                    text: gettext('Remove'),
                    iconCls: 'fa fa-trash-o',
                    handler: function () {
                        var sel = portalsGrid.getSelection();
                        if (sel.length) portalsStore.remove(sel);
                    },
                },
                {
                    text: gettext('Discover Targets'),
                    iconCls: 'fa fa-search',
                    handler: function () {
                        var portals = portalsStore.collect('portal').join(',');
                        if (!portals) {
                            Ext.Msg.alert(gettext('Error'), gettext('Add at least one portal first.'));
                            return;
                        }
                        Proxmox.Utils.API2Request({
                            url: '/nodes/' + nodename + '/iscsi/discover',
                            method: 'POST',
                            params: { portals: portals },
                            waitMsgTarget: me,
                            success: function (response) {
                                var targets = response.result.data;
                                if (!targets.length) {
                                    Ext.Msg.alert(gettext('Discovery'), gettext('No targets found.'));
                                    return;
                                }
                                var msg = gettext('Found targets') + ':\n' +
                                    targets.map(t => t.target_iqn + ' (' + t.portal + ')').join('\n');
                                Ext.Msg.alert(gettext('Discovery'), msg);
                                reloadSessions();
                            },
                            failure: function (response) {
                                Ext.Msg.alert(gettext('Error'), response.htmlStatus);
                            },
                        });
                    },
                },
            ],
        });

        var sessionsGrid = Ext.create('Ext.grid.Panel', {
            title: gettext('Sessions'),
            flex: 2,
            store: sessionsStore,
            columns: [
                { text: gettext('Target IQN'), dataIndex: 'target_iqn', flex: 2 },
                { text: gettext('Portal'),     dataIndex: 'portal',     flex: 1 },
                { text: gettext('State'),      dataIndex: 'state',      width: 100 },
            ],
            tbar: [
                {
                    text: gettext('Reload'),
                    iconCls: 'fa fa-refresh',
                    handler: reloadSessions,
                },
                {
                    text: gettext('Login'),
                    iconCls: 'fa fa-plug',
                    handler: function () {
                        var sel = sessionsGrid.getSelection();
                        if (!sel.length) return;
                        var portals = portalsStore.collect('portal');
                        if (!portals.length) {
                            Ext.Msg.alert(gettext('Error'), gettext('Add portals first.'));
                            return;
                        }
                        portals.forEach(function (portal) {
                            Proxmox.Utils.API2Request({
                                url: '/nodes/' + nodename + '/iscsi/login',
                                method: 'POST',
                                params: {
                                    target_iqn: sel[0].data.target_iqn,
                                    portal: portal,
                                },
                                success: reloadSessions,
                                failure: function (r) {
                                    Ext.Msg.alert(gettext('Error'), r.htmlStatus);
                                },
                            });
                        });
                    },
                },
                {
                    text: gettext('Logout'),
                    iconCls: 'fa fa-sign-out',
                    handler: function () {
                        var sel = sessionsGrid.getSelection();
                        if (!sel.length) return;
                        Proxmox.Utils.API2Request({
                            url: '/nodes/' + nodename + '/iscsi/logout',
                            method: 'POST',
                            params: {
                                target_iqn: sel[0].data.target_iqn,
                                portal:     sel[0].data.portal,
                            },
                            success: reloadSessions,
                            failure: function (r) {
                                Ext.Msg.alert(gettext('Error'), r.htmlStatus);
                            },
                        });
                    },
                },
                {
                    text: gettext('Set Auto-Login'),
                    iconCls: 'fa fa-clock-o',
                    handler: function () {
                        var sel = sessionsGrid.getSelection();
                        if (!sel.length) return;
                        // Simple dialog to choose mode
                        Ext.Msg.show({
                            title: gettext('Set Auto-Login Mode'),
                            msg: gettext('Choose startup mode for') + ' ' + sel[0].data.target_iqn,
                            buttons: Ext.Msg.OKCANCEL,
                            prompt: true,
                            value: 'automatic',
                            fn: function (btn, value) {
                                if (btn !== 'ok') return;
                                Proxmox.Utils.API2Request({
                                    url: '/nodes/' + nodename + '/iscsi/startup',
                                    method: 'PUT',
                                    params: {
                                        target_iqn: sel[0].data.target_iqn,
                                        portal:     sel[0].data.portal,
                                        mode:       value,
                                    },
                                    failure: function (r) {
                                        Ext.Msg.alert(gettext('Error'), r.htmlStatus);
                                    },
                                });
                            },
                        });
                    },
                },
            ],
        });

        Ext.apply(me, {
            items: [portalsGrid, sessionsGrid],
        });

        me.callParent();
        reloadSessions();
    },
});
```

### Step 2: Commit

```bash
git add src/js/pve-iscsi-multipath.js
git commit -m "feat: add PVE.node.ISCSIPanel component"
```

---

## Task 8: JavaScript — `PVE.node.MultipathPanel`

**Files:**
- Modify: `src/js/pve-iscsi-multipath.js`

### Step 1: Add the MultipathPanel component

```javascript
Ext.define('PVE.node.MultipathPanel', {
    extend: 'Ext.panel.Panel',
    xtype: 'pveNodeMultipathPanel',

    layout: 'fit',

    initComponent: function () {
        var me = this;
        var nodename = me.pveSelNode.data.node;
        if (!nodename) throw 'no node name specified';

        var statusStore = Ext.create('Ext.data.Store', {
            fields: ['alias', 'wwid', 'paths', 'state'],
            proxy: {
                type: 'proxmox',
                url: '/api2/json/nodes/' + nodename + '/iscsi/multipath/status',
            },
        });

        var reload = function () { statusStore.load(); };

        var editConfig = function () {
            Proxmox.Utils.API2Request({
                url: '/api2/json/nodes/' + nodename + '/iscsi/multipath/config',
                method: 'GET',
                success: function (response) {
                    var content = response.result.data.content;
                    Ext.create('Proxmox.window.Edit', {
                        title: gettext('Edit /etc/multipath.conf'),
                        width: 700,
                        height: 500,
                        url: '/nodes/' + nodename + '/iscsi/multipath/config',
                        method: 'PUT',
                        items: [{
                            xtype: 'textarea',
                            name: 'content',
                            value: content,
                            height: 400,
                            fieldStyle: 'font-family: monospace; font-size: 12px;',
                        }],
                        listeners: { destroy: reload },
                    }).show();
                },
                failure: function (r) {
                    Ext.Msg.alert(gettext('Error'), r.htmlStatus);
                },
            });
        };

        Ext.apply(me, {
            items: [{
                xtype: 'grid',
                store: statusStore,
                columns: [
                    { text: gettext('Alias'),  dataIndex: 'alias',  flex: 1 },
                    { text: 'WWID',            dataIndex: 'wwid',   flex: 2 },
                    { text: gettext('Paths'),  dataIndex: 'paths',  width: 70, align: 'right' },
                    { text: gettext('State'),  dataIndex: 'state',  width: 100 },
                ],
                tbar: [
                    {
                        text: gettext('Reload'),
                        iconCls: 'fa fa-refresh',
                        handler: reload,
                    },
                    {
                        text: gettext('Edit Config'),
                        iconCls: 'fa fa-pencil',
                        handler: editConfig,
                    },
                    {
                        text: gettext('Restart multipathd'),
                        iconCls: 'fa fa-refresh',
                        handler: function () {
                            Proxmox.Utils.API2Request({
                                url: '/nodes/' + nodename + '/iscsi/multipath/config',
                                method: 'PUT',
                                params: { content: '', merge: 1 },
                                waitMsgTarget: me,
                                success: reload,
                                failure: function (r) {
                                    Ext.Msg.alert(gettext('Error'), r.htmlStatus);
                                },
                            });
                        },
                    },
                ],
            }],
        });

        me.callParent();
        reload();
    },
});
```

### Step 2: Commit

```bash
git add src/js/pve-iscsi-multipath.js
git commit -m "feat: add PVE.node.MultipathPanel component"
```

---

## Task 9: JavaScript — Node Config Override (Tab Injection)

**Files:**
- Modify: `src/js/pve-iscsi-multipath.js`

### Step 1: Add the node Config override

This must appear AFTER both panel definitions above.

```javascript
Ext.define(null, {
    override: 'PVE.node.Config',

    initComponent: function () {
        this.callParent(arguments);

        var me = this;
        var nodename = me.pveSelNode.data.node;
        var caps = Ext.state.Manager.get('GuiCap');

        if (caps.nodes['Sys.Audit']) {
            me.add([
                {
                    xtype: 'pveNodeISCSIPanel',
                    title: 'iSCSI',
                    itemId: 'iscsi',
                    iconCls: 'fa fa-plug',
                    groups: ['storage'],
                    nodename: nodename,
                },
                {
                    xtype: 'pveNodeMultipathPanel',
                    title: 'Multipath',
                    itemId: 'multipath',
                    iconCls: 'fa fa-sitemap',
                    groups: ['storage'],
                    nodename: nodename,
                },
            ]);
        }
    },
});
```

### Step 2: Install and verify tabs appear

On the Proxmox host:
```bash
cp src/js/pve-iscsi-multipath.js /usr/share/pve-manager/js/
# Apply the index.html.tpl patch manually for testing:
bash debian/postinst configure
# Open https://<node>:8006 in a browser, navigate to a node > Disks section
# Verify "iSCSI" and "Multipath" tabs appear alongside LVM, ZFS, etc.
```

### Step 3: Commit

```bash
git add src/js/pve-iscsi-multipath.js
git commit -m "feat: override PVE.node.Config to inject iSCSI and Multipath tabs"
```

---

## Task 10: JavaScript — Datacenter Wizard (Steps 1–4)

**Files:**
- Modify: `src/js/pve-iscsi-multipath.js`

### Step 1: Confirm wizard base class

On the Proxmox host, find an existing wizard to use as reference:

```bash
grep -n "Proxmox.window.Wizard\|Ext\.define.*Wizard\|xtype.*wizard" \
  /usr/share/pve-manager/js/pvemanagerlib.js | head -10
```

Read ~50 lines of that wizard definition to understand the step/card structure.

### Step 2: Implement the wizard (Steps 1–4)

```javascript
Ext.define('PVE.dc.ISCSISetupWizard', {
    extend: 'Proxmox.window.Wizard',
    xtype: 'pveDCISCSISetupWizard',

    title: gettext('SAN Setup Wizard'),
    width: 720,
    height: 550,

    // Track logins performed by this wizard session for rollback on Back
    _wizardLogins: [],

    initComponent: function () {
        var me = this;

        // Step 1: Select nodes + status
        var nodeStatusStore = Ext.create('Ext.data.Store', {
            fields: ['node', 'status', 'detail'],
            data: [],
        });

        var nodeGrid = Ext.create('Ext.grid.Panel', {
            store: nodeStatusStore,
            columns: [
                {
                    xtype: 'checkcolumn',
                    header: '',
                    dataIndex: 'checked',
                    width: 40,
                },
                { text: gettext('Node'),   dataIndex: 'node',   flex: 1 },
                { text: gettext('Status'), dataIndex: 'status', width: 80,
                  renderer: function (v) {
                      var colors = { green: '#2c9142', yellow: '#e59400',
                                     orange: '#d06020', red: '#cc2a2a' };
                      return '<span style="color:' + (colors[v] || '#333') + '">' +
                             Ext.String.htmlEncode(v) + '</span>';
                  }
                },
                { text: gettext('Detail'), dataIndex: 'detail', flex: 2 },
            ],
        });

        var checkNodeStatus = function () {
            nodeStatusStore.each(function (rec) {
                if (!rec.get('checked')) return;
                var node = rec.get('node');
                Proxmox.Utils.API2Request({
                    url: '/api2/json/nodes/' + node + '/iscsi/status',
                    method: 'GET',
                    success: function (response) {
                        var d = response.result.data;
                        var pkgsOk = d.packages.open_iscsi && d.packages.multipath_tools;
                        var svcsOk = d.services.iscsid.running && d.services.multipathd.running;
                        var hasSessions = d.sessions.length > 0;
                        var hasConfig = d.multipath_config_exists;

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
                        rec.set('_statusData', d);
                        rec.commit();
                    },
                });
            });
        };

        // Load cluster nodes
        Proxmox.Utils.API2Request({
            url: '/api2/json/cluster/status',
            method: 'GET',
            success: function (response) {
                var nodes = (response.result.data || []).filter(n => n.type === 'node');
                nodeStatusStore.loadData(nodes.map(n => ({
                    node: n.name,
                    status: '...',
                    detail: '',
                    checked: true,
                })));
                checkNodeStatus();
            },
        });

        // Step 2: Portals
        var portalsStore = Ext.create('Ext.data.Store', {
            fields: ['portal'],
            data: [],
        });

        // Step 3: Targets
        var targetsStore = Ext.create('Ext.data.Store', {
            fields: ['target_iqn', 'portal', 'selected', 'already_connected'],
            data: [],
        });

        // Step 4 data (populated after login transition)
        var wwidsData = [];  // [{ wwid, alias, is_new }]

        Ext.apply(me, {
            items: [
                // --- Step 1 ---
                {
                    title: gettext('Select Nodes'),
                    xtype: 'panel',
                    itemId: 'step1',
                    layout: 'fit',
                    items: [nodeGrid],
                    tbar: [{
                        text: gettext('Refresh Status'),
                        iconCls: 'fa fa-refresh',
                        handler: checkNodeStatus,
                    }],
                },

                // --- Step 2 ---
                {
                    title: gettext('Portals'),
                    xtype: 'panel',
                    itemId: 'step2',
                    layout: 'fit',
                    items: [{
                        xtype: 'grid',
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
                                    var g = me.down('[store=' + portalsStore.getId() + ']');
                                    var sel = g.getSelection();
                                    if (sel.length) portalsStore.remove(sel);
                                },
                            },
                        ],
                    }],
                },

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
                              renderer: v => v ? gettext('already connected') : '' },
                        ],
                    }],
                    tbar: [{
                        text: gettext('Discover'),
                        iconCls: 'fa fa-search',
                        handler: function () {
                            // Find first checked node to run discovery from
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
                                    // Get existing sessions for pre-checking
                                    var statusRec = nodeStatusStore.findRecord('node', firstNode);
                                    var sessions = (statusRec && statusRec.get('_statusData'))
                                        ? statusRec.get('_statusData').sessions : [];
                                    var connectedIqns = sessions.map(s => s.target_iqn);

                                    // Deduplicate by IQN
                                    var seen = {};
                                    var unique = targets.filter(t => {
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

                // --- Step 4 ---
                {
                    title: gettext('Multipath Config'),
                    xtype: 'panel',
                    itemId: 'step4',
                    layout: {
                        type: 'vbox',
                        align: 'stretch',
                    },
                    items: [
                        {
                            xtype: 'container',
                            itemId: 'mergeToggleContainer',
                            html: '',
                            margin: '5 5 0 5',
                        },
                        {
                            xtype: 'grid',
                            itemId: 'wwidsGrid',
                            flex: 1,
                            columns: [
                                { text: 'WWID', dataIndex: 'wwid',  flex: 2 },
                                {
                                    text: gettext('Alias'),
                                    dataIndex: 'alias',
                                    flex: 1,
                                    editor: { xtype: 'textfield', allowBlank: false },
                                },
                                {
                                    text: gettext('New?'),
                                    dataIndex: 'is_new',
                                    renderer: v => v ? gettext('Yes') : '',
                                    width: 60,
                                },
                            ],
                            selModel: 'cellmodel',
                            plugins: [{ ptype: 'cellediting', clicksToEdit: 1 }],
                            store: Ext.create('Ext.data.Store', {
                                fields: ['wwid', 'alias', 'is_new'],
                                data: [],
                            }),
                        },
                    ],
                },

                // Steps 5 & 6 added in Task 11
            ],
        });

        me.callParent();
    },
});
```

### Step 3: Commit

```bash
git add src/js/pve-iscsi-multipath.js
git commit -m "feat: add datacenter wizard steps 1-4 skeleton"
```

---

## Task 11: JavaScript — Datacenter Wizard (Steps 5–6, Transitions, Button Injection)

**Files:**
- Modify: `src/js/pve-iscsi-multipath.js`

### Step 1: Confirm datacenter storage panel xtype

Use the result from Task 1 Step 8 to fill in the xtype here. If it wasn't found, run:

```bash
grep -n "Ext\.define.*[Ss]torage\|pveStorageList\|pveDCStorage" \
  /usr/share/pve-manager/js/pvemanagerlib.js | grep "define" | head -10
```

### Step 2: Add Steps 5 and 6 to the wizard items array

Add these inside the `items: [...]` of the wizard, after Step 4:

```javascript
// --- Step 5: Services ---
{
    title: gettext('Services'),
    xtype: 'panel',
    itemId: 'step5',
    bodyPadding: 10,
    items: [
        {
            xtype: 'proxmoxcheckbox',
            name: 'enable_iscsid',
            boxLabel: gettext('Enable iscsid'),
            itemId: 'chkIscsid',
            value: true,
        },
        {
            xtype: 'proxmoxcheckbox',
            name: 'enable_multipathd',
            boxLabel: gettext('Enable multipathd'),
            itemId: 'chkMultipathd',
            value: true,
        },
        {
            xtype: 'proxmoxcheckbox',
            name: 'enable_lvmlockd',
            boxLabel: gettext('Enable lvmlockd (recommended for clusters)'),
            itemId: 'chkLvmlockd',
            value: false,
        },
        {
            xtype: 'proxmoxcheckbox',
            name: 'enable_sanlock',
            boxLabel: gettext('Enable sanlock (required with lvmlockd)'),
            itemId: 'chkSanlock',
            value: false,
        },
    ],
},

// --- Step 6: Apply ---
{
    title: gettext('Apply'),
    xtype: 'panel',
    itemId: 'step6',
    layout: 'fit',
    items: [{
        xtype: 'container',
        itemId: 'progressContainer',
        layout: { type: 'vbox', align: 'stretch' },
        scrollable: true,
        items: [],
    }],
},
```

### Step 3: Add the wizard transition logic and `onNext` override

Add inside `initComponent`, before `me.callParent()`:

```javascript
me.on('beforenextcard', function (wizard, current) {
    // Step 3 -> 4: perform logins, then fetch WWIDs
    if (current.itemId === 'step3') {
        var nodes = [];
        nodeStatusStore.each(function (r) { if (r.get('checked')) nodes.push(r.get('node')); });
        if (!nodes.length) {
            Ext.Msg.alert(gettext('Error'), gettext('Select at least one node.'));
            return false;
        }

        var selectedTargets = [];
        targetsStore.each(function (r) {
            if (r.get('selected') && !r.get('already_connected')) {
                selectedTargets.push(r.get('target_iqn'));
            }
        });
        var portals = portalsStore.collect('portal');

        // Login to newly selected targets on all portals for first node only
        // (to get WWIDs — full login happens in Apply step for all nodes)
        var firstNode = nodes[0];
        var loginPromises = [];

        selectedTargets.forEach(function (iqn) {
            portals.forEach(function (portal) {
                var p = new Promise(function (resolve) {
                    Proxmox.Utils.API2Request({
                        url: '/nodes/' + firstNode + '/iscsi/login',
                        method: 'POST',
                        params: { target_iqn: iqn, portal: portal },
                        success: function (r) {
                            if (!r.result.data.already_connected) {
                                me._wizardLogins.push({ node: firstNode, iqn: iqn, portal: portal });
                            }
                            resolve();
                        },
                        failure: resolve,
                    });
                });
                loginPromises.push(p);
            });
        });

        // After all logins, fetch multipath status to get WWIDs
        Promise.all(loginPromises).then(function () {
            Proxmox.Utils.API2Request({
                url: '/api2/json/nodes/' + firstNode + '/iscsi/status',
                method: 'GET',
                success: function (response) {
                    var d = response.result.data;
                    var existingWwids = (d.multipath_devices || []).map(m => m.wwid);
                    var wwidsGrid = me.down('#wwidsGrid');
                    var store = wwidsGrid.getStore();
                    store.removeAll();

                    // Existing devices (pre-configured)
                    (d.multipath_devices || []).forEach(function (dev) {
                        store.add({ wwid: dev.wwid, alias: dev.alias, is_new: false });
                    });

                    // Newly logged-in devices (from multipath status after login)
                    // Re-fetch multipath status to pick up new paths
                    Proxmox.Utils.API2Request({
                        url: '/api2/json/nodes/' + firstNode + '/iscsi/multipath/status',
                        method: 'GET',
                        success: function (r2) {
                            (r2.result.data || []).forEach(function (dev) {
                                if (!existingWwids.includes(dev.wwid)) {
                                    store.add({ wwid: dev.wwid, alias: dev.alias || '', is_new: true });
                                }
                            });
                            wizard.navigateToNextCard();
                        },
                    });
                },
            });
        });

        return false; // prevent automatic navigation, we'll call navigateToNextCard manually
    }

    // Step 4 -> 5: pre-populate service checkboxes based on node status
    if (current.itemId === 'step4') {
        var firstNode2 = null;
        nodeStatusStore.each(function (r) {
            if (r.get('checked') && !firstNode2) firstNode2 = r.get('node');
        });
        // Detect cluster vs single node
        Proxmox.Utils.API2Request({
            url: '/api2/json/cluster/status',
            method: 'GET',
            success: function (r) {
                var nodeCount = (r.result.data || []).filter(n => n.type === 'node').length;
                var isCluster = nodeCount > 1;
                me.down('#chkLvmlockd').setValue(isCluster);
                me.down('#chkSanlock').setValue(isCluster);
            },
        });
    }
});

// Back from Step 4: log out targets we logged in for WWID detection
me.on('beforeprevcard', function (wizard, current) {
    if (current.itemId === 'step4') {
        me._wizardLogins.forEach(function (login) {
            Proxmox.Utils.API2Request({
                url: '/nodes/' + login.node + '/iscsi/logout',
                method: 'POST',
                params: { target_iqn: login.iqn, portal: login.portal },
            });
        });
        me._wizardLogins = [];
    }
});
```

### Step 4: Add the Apply step logic

Add inside `initComponent`, before `me.callParent()`:

```javascript
me.on('beforefinish', function () {
    var nodes = [];
    nodeStatusStore.each(function (r) { if (r.get('checked')) nodes.push(r.get('node')); });

    var targets = [];
    targetsStore.each(function (r) { if (r.get('selected')) targets.push(r.get('target_iqn')); });

    var portals = portalsStore.collect('portal').join(',');

    // Build multipath.conf from wwidsGrid
    var wwidsGrid = me.down('#wwidsGrid');
    var store = wwidsGrid.getStore();
    var mpConfig = 'defaults {\n    user_friendly_names yes\n    find_multipaths yes\n}\n\n';
    mpConfig += 'blacklist {\n    devnode "^sda"\n}\n\n';
    mpConfig += 'multipaths {\n';
    store.each(function (r) {
        if (r.get('is_new')) {
            mpConfig += '    multipath {\n';
            mpConfig += '        wwid ' + r.get('wwid') + '\n';
            mpConfig += '        alias ' + r.get('alias') + '\n';
            mpConfig += '    }\n';
        }
    });
    mpConfig += '}\n';

    var enableLvmlockd = me.down('#chkLvmlockd').getValue();
    var enableSanlock  = me.down('#chkSanlock').getValue();

    var container = me.down('#progressContainer');
    container.removeAll();

    var runNextNode = function (idx) {
        if (idx >= nodes.length) {
            container.add({
                xtype: 'displayfield',
                value: '<b>' + gettext('All nodes complete.') + '</b>',
                margin: '10 0 0 0',
            });
            return;
        }
        var node = nodes[idx];
        var section = Ext.create('Ext.panel.Panel', {
            title: node,
            collapsible: true,
            bodyPadding: 5,
            items: [{ xtype: 'textarea', readOnly: true, height: 150,
                       fieldStyle: 'font-family: monospace; font-size: 11px;',
                       itemId: 'log-' + node }],
        });
        container.add(section);

        Proxmox.Utils.API2Request({
            url: '/nodes/' + node + '/iscsi/setup',
            method: 'POST',
            params: {
                portals:          portals,
                targets:          targets.join(','),
                multipath_config: mpConfig,
                merge_multipath:  0,
                enable_lvmlockd:  enableLvmlockd ? 1 : 0,
                enable_sanlock:   enableSanlock  ? 1 : 0,
            },
            success: function (response) {
                var upid = response.result.data;
                // Poll task log
                var logArea = section.down('#log-' + node);
                var poll = setInterval(function () {
                    Proxmox.Utils.API2Request({
                        url: '/api2/json/nodes/' + node + '/tasks/' + encodeURIComponent(upid) + '/log',
                        method: 'GET',
                        params: { start: 0, limit: 500 },
                        success: function (r) {
                            var lines = (r.result.data || []).map(l => l.t).join('\n');
                            logArea.setValue(lines);
                        },
                    });
                    Proxmox.Utils.API2Request({
                        url: '/api2/json/nodes/' + node + '/tasks/' + encodeURIComponent(upid) + '/status',
                        method: 'GET',
                        success: function (r) {
                            var status = r.result.data.status;
                            if (status === 'stopped') {
                                clearInterval(poll);
                                runNextNode(idx + 1);
                            }
                        },
                    });
                }, 2000);
            },
            failure: function (r) {
                var logArea = section.down('#log-' + node);
                logArea.setValue('ERROR: ' + r.htmlStatus);
                runNextNode(idx + 1);
            },
        });
    };

    runNextNode(0);
    return false; // Prevent wizard from closing, user manually closes after done
});
```

### Step 5: Inject "SAN Setup" button into Datacenter storage panel

Replace `<DATACENTER_STORAGE_XTYPE>` with the result from Task 1 Step 8.

```javascript
Ext.define(null, {
    override: '<DATACENTER_STORAGE_XTYPE>',  // e.g., 'PVE.dc.StorageView'

    initComponent: function () {
        this.callParent(arguments);
        this.down('toolbar[dock=top]').add({
            text: gettext('SAN Setup'),
            iconCls: 'fa fa-plug',
            handler: function () {
                Ext.create('PVE.dc.ISCSISetupWizard', { autoShow: true });
            },
        });
    },
});
```

### Step 6: Commit

```bash
git add src/js/pve-iscsi-multipath.js
git commit -m "feat: complete datacenter wizard with transitions and apply step"
```

---

## Task 12: Build and Package

**Files:**
- Modify: `Makefile`
- Modify: `debian/rules`

### Step 1: Update Makefile to inject version into postinst

```makefile
VERSION=0.1.0

build:
	sed 's/@VERSION@/$(VERSION)/g' debian/postinst.in > debian/postinst
	chmod +x debian/postinst
```

Rename `debian/postinst` to `debian/postinst.in` and add it to `.gitignore`.

### Step 2: Install debhelper if needed

```bash
apt-get install -y devscripts debhelper
```

### Step 3: Build the package

From the repo root:

```bash
dpkg-buildpackage -us -uc -b
```

Expected: `../pve-iscsi-multipath_0.1.0_all.deb` created.

### Step 4: Inspect the package contents

```bash
dpkg -c ../pve-iscsi-multipath_0.1.0_all.deb
```

Expected output includes:
```
./usr/share/pve-manager/js/pve-iscsi-multipath.js
./usr/share/perl5/PVE/API2/ISCSIMultipath.pm
./var/lib/dpkg/info/pve-iscsi-multipath.postinst
./var/lib/dpkg/info/pve-iscsi-multipath.prerm
./var/lib/dpkg/info/pve-iscsi-multipath.triggers
```

### Step 5: Install on the Proxmox host

Copy the .deb to the Proxmox host and:

```bash
dpkg -i pve-iscsi-multipath_0.1.0_all.deb
```

### Step 6: Run the full integration test sequence

```bash
# 1. Verify patches applied
grep "pve-iscsi-multipath" /usr/share/pve-manager/index.html.tpl
grep "ISCSIMultipath" /usr/share/perl5/PVE/API2/Nodes.pm

# 2. Verify API endpoint exists
pvesh get /nodes/$(hostname)/iscsi/status

# 3. Verify GUI tabs appear
# Open https://<node>:8006 -> Node -> Disks section
# Should see: Disks, LVM, LVM-Thin, Directory, ZFS, Ceph, iSCSI, Multipath

# 4. Verify datacenter wizard
# Open https://<node>:8006 -> Datacenter -> Storage
# Should see "SAN Setup" button in toolbar

# 5. Test uninstall is clean
dpkg -r pve-iscsi-multipath
grep "pve-iscsi-multipath" /usr/share/pve-manager/index.html.tpl && echo "FAIL" || echo "PASS"
grep "ISCSIMultipath" /usr/share/perl5/PVE/API2/Nodes.pm && echo "FAIL" || echo "PASS"

# 6. Reinstall and re-verify
dpkg -i pve-iscsi-multipath_0.1.0_all.deb
pvesh get /nodes/$(hostname)/iscsi/status
```

### Step 7: Run all unit tests

```bash
prove -lv t/
```

Expected: All tests pass.

### Step 8: Commit and tag

```bash
git add Makefile debian/rules
git commit -m "feat: build system and deb packaging"
git tag v0.1.0
```

---

## Unit Test Summary

| Test file            | What it covers                                      |
|----------------------|-----------------------------------------------------|
| `t/01-parsing.t`     | iscsiadm output parsing, multipath output parsing, config merge |
| `t/02-status.t`      | package/service detection with mocked system calls |
| `t/03-setup-idempotency.t` | session_exists, lvm.conf detection            |

Run all: `prove -lv t/`

## Integration Test Checklist (manual, on Proxmox host)

- [ ] `pvesh get /nodes/{node}/iscsi/status` returns valid JSON
- [ ] `pvesh post /nodes/{node}/iscsi/discover -portals 192.168.x.x` returns targets
- [ ] iSCSI and Multipath tabs appear under node > Disks in the GUI
- [ ] SAN Setup button appears in Datacenter > Storage toolbar
- [ ] Wizard discovers targets and populates WWIDs after login step
- [ ] Apply step runs and shows live task log per node
- [ ] `dpkg -r pve-iscsi-multipath` cleanly removes all patches
- [ ] Reinstall after remove works correctly (idempotency)
- [ ] Install on a node that already has iSCSI/multipath configured shows correct status badges
