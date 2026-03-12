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
