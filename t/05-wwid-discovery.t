#!/usr/bin/perl
use strict;
use warnings;
use Test::More tests => 14;
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

# Input-side ,tpgt stripping: caller passes portal WITH tpgt suffix
is(PVE::API2::ISCSIMultipath::_parse_session_host(
       $session_p3,
       'iqn.2005-10.org.freenas.ctl:proxmox-bruce',
       '192.168.122.15:3260,1'),
   3, '_parse_session_host: strips ,tpgt from caller-supplied portal arg');

# Output-side ,tpgt stripping: iscsiadm output has ,tpgt, caller does not
# (The $session_p3 fixture has "Current Portal: 192.168.122.15:3260,1" — caller passes without ,1)
is(PVE::API2::ISCSIMultipath::_parse_session_host(
       $session_p3,
       'iqn.2005-10.org.freenas.ctl:proxmox-mgmt',
       '192.168.122.15'),
   5, '_parse_session_host: strips ,tpgt from iscsiadm output and auto-appends :3260');

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
