#!/usr/bin/perl
use strict;
use warnings;
use Test::More tests => 16;

use lib 'src/perl';
use lib 't/lib';
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

# Structural check: new entry must appear AFTER the existing block, not inside it
my $pos_old = index($merged, 'proxmox-old');
my $pos_new = index($merged, 'proxmox-new');
ok($pos_old < $pos_new, 'merge_multipath_config: new entry appears after existing entry');
