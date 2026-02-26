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
