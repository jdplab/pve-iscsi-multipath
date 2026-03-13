#!/usr/bin/perl
use strict;
use warnings;
use Test::More tests => 11;

use lib 'src/perl';
use lib 't/lib';
use PVE::API2::ISCSIMultipath;

# Drive _run_cmd with a pre-loaded list of responses.
# Each entry: { die => 'msg' } to throw, or undef/absent to succeed.
# Also records every command invoked for later inspection.
my @calls;
my @responses;

{
    no warnings 'redefine';
    *PVE::API2::ISCSIMultipath::_run_cmd = sub {
        my ($cmd, %opts) = @_;
        push @calls, join(' ', @$cmd);
        my $r = shift @responses;
        die $r->{die} if $r && $r->{die};
    };
}

sub reset_mock {
    @calls     = ();
    @responses = @_;
}

my $dev = '/dev/mapper/test-device';

# ── 1. pvdisplay succeeds: PV already in LVM cache ──────────────────────────
reset_mock();  # pvdisplay succeeds (no response → success)
my $existed = PVE::API2::ISCSIMultipath::_ensure_pv($dev);
is($existed, 1, 'pvdisplay ok → pv_existed=1');
is(scalar @calls, 1,          'only pvdisplay called');
like($calls[0], qr/pvdisplay/, 'first call is pvdisplay');

# ── 2. pvdisplay fails, pvcreate succeeds: fresh PV created ─────────────────
reset_mock({ die => 'pvdisplay: not found' });  # pvdisplay fails
                                                # pvcreate succeeds (no response)
$existed = PVE::API2::ISCSIMultipath::_ensure_pv($dev);
is($existed, 0, 'pvdisplay fail + pvcreate ok → pv_existed=0');
is(scalar @calls, 2, 'pvdisplay then pvcreate called');
like($calls[1], qr/pvcreate/, 'second call is pvcreate');

# ── 3. pvdisplay fails, pvcreate fails, pvscan imports PV ───────────────────
reset_mock(
    { die => 'pvdisplay: not found' },       # pvdisplay → fail
    { die => 'pvcreate: existing labels' },  # pvcreate → fail
    undef,                                   # pvscan --cache → success
    undef,                                   # pvdisplay retry → success
);
$existed = PVE::API2::ISCSIMultipath::_ensure_pv($dev);
is($existed, 1, 'pvcreate fail + pvscan import → pv_existed=1');
is(scalar @calls, 4, 'pvdisplay, pvcreate, pvscan --cache, pvdisplay-retry all called');
like($calls[2], qr/pvscan.*--cache/, 'third call is pvscan --cache');

# ── 4. pvdisplay fails, pvcreate fails, pvscan cannot import ────────────────
reset_mock(
    { die => 'pvdisplay: not found' },       # pvdisplay → fail
    { die => 'pvcreate: existing labels' },  # pvcreate → fail
    undef,                                   # pvscan --cache → success (ran ok)
    { die => 'pvdisplay: still not found' }, # pvdisplay retry → fail
);
eval { PVE::API2::ISCSIMultipath::_ensure_pv($dev) };
ok($@, 'pvscan cannot import → _ensure_pv dies');
like($@, qr/pvcreate/, 'error message preserves original pvcreate failure');
