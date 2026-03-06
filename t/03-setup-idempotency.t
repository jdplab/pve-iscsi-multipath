#!/usr/bin/perl
use strict;
use warnings;
use Test::More tests => 6;

use lib 'src/perl';
use lib 't/lib';
use PVE::API2::ISCSIMultipath;

# Test session_exists
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

# Test lvm_conf_has_lvmlockd
my $lvm_conf_with = "global {\n    use_lvmlockd = 1\n}\n";
ok(PVE::API2::ISCSIMultipath::lvm_conf_has_lvmlockd($lvm_conf_with),
   'lvm_conf_has_lvmlockd: detects enabled setting');
ok(!PVE::API2::ISCSIMultipath::lvm_conf_has_lvmlockd("global {\n}\n"),
   'lvm_conf_has_lvmlockd: absent → false');
ok(!PVE::API2::ISCSIMultipath::lvm_conf_has_lvmlockd("global {\n    use_lvmlockd = 0\n}\n"),
   'lvm_conf_has_lvmlockd: use_lvmlockd=0 → false');
