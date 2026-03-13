#!/usr/bin/perl
use strict;
use warnings;
use Test::More tests => 32;

use lib 'src/perl';
use lib 't/lib';

# Capture all register_method calls before loading our module so we can
# inspect every endpoint's schema without needing a live Proxmox stack.
my %methods;
require PVE::RESTHandler;
require PVE::JSONSchema;
require PVE::RPCEnvironment;
# NOTE: do NOT pre-load PVE::Tools here — test 32 verifies the module loads it eagerly
{
    no warnings 'redefine';
    *PVE::RESTHandler::register_method = sub {
        my ($class, $spec) = @_;
        $methods{ $spec->{name} } = $spec if defined $spec->{name};
    };
}
require PVE::API2::ISCSIMultipath;

# ── helpers ────────────────────────────────────────────────────────────────
sub returns_props       { $methods{$_[0]}{returns}{properties} }
sub returns_items_props { $methods{$_[0]}{returns}{items}{properties} }
sub param_prop          { $methods{$_[0]}{parameters}{properties}{$_[1]} }

# ── Issue 1: array return schemas must declare item properties ──────────────

# sessions
my $p = returns_items_props('sessions');
ok(defined $p,               'sessions: items have properties');
ok(exists $p->{portal},      'sessions: items.portal defined');
ok(exists $p->{target_iqn},  'sessions: items.target_iqn defined');
ok(exists $p->{state},       'sessions: items.state defined');

# discover
$p = returns_items_props('discover');
ok(defined $p,               'discover: items have properties');
ok(exists $p->{target_iqn},  'discover: items.target_iqn defined');
ok(exists $p->{portal},      'discover: items.portal defined');
ok(exists $p->{tpgt},        'discover: items.tpgt defined');

# fc_hbas
$p = returns_items_props('fc_hbas');
ok(defined $p,               'fc_hbas: items have properties');
ok(exists $p->{name},        'fc_hbas: items.name defined');
ok(exists $p->{port_state},  'fc_hbas: items.port_state defined');

# fc_targets
$p = returns_items_props('fc_targets');
ok(defined $p,               'fc_targets: items have properties');
ok(exists $p->{port_name},   'fc_targets: items.port_name defined');
ok(exists $p->{hba},         'fc_targets: items.hba defined');

# multipath_status
$p = returns_items_props('multipath_status');
ok(defined $p,               'multipath_status: items have properties');
ok(exists $p->{alias},       'multipath_status: items.alias defined');
ok(exists $p->{wwid},        'multipath_status: items.wwid defined');
ok(exists $p->{paths},       'multipath_status: items.paths defined');
ok(exists $p->{state},       'multipath_status: items.state defined');

# ── Issue 2: status return must declare its top-level properties ────────────
$p = returns_props('status');
ok(defined $p,                          'status: returns has properties');
ok(exists $p->{packages},              'status: returns.packages defined');
ok(exists $p->{services},              'status: returns.services defined');
ok(exists $p->{sessions},              'status: returns.sessions defined');
ok(exists $p->{multipath_devices},     'status: returns.multipath_devices defined');
ok(exists $p->{fc_hba_count},          'status: returns.fc_hba_count defined');

# ── Issue 3: lvm_setup boolean flags must use type 'boolean' ───────────────
$p = returns_props('lvm_setup');
is($p->{pv_existed}{type},      'boolean', 'lvm_setup: pv_existed is boolean');
is($p->{vg_existed}{type},      'boolean', 'lvm_setup: vg_existed is boolean');
is($p->{storage_existed}{type}, 'boolean', 'lvm_setup: storage_existed is boolean');

# ── Issue 4: portal param must use pve-storage-portal-dns format ───────────
for my $ep (qw(login logout set_startup)) {
    my $portal = param_prop($ep, 'portal');
    is($portal->{format}, 'pve-storage-portal-dns',
        "$ep: portal uses pve-storage-portal-dns format");
}

# ── Issue 5: PVE::Tools must be loaded at module load time (not lazily) ────
# If the module uses `use PVE::Tools` at top level, %INC will contain the
# entry immediately after require. With lazy `require` inside _run_cmd it
# will NOT be present until that sub is actually called.
ok(defined $INC{'PVE/Tools.pm'},
    'PVE::Tools loaded at module load time (not lazily inside _run_cmd)');
